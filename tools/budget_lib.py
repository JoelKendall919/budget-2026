"""
Budget 2026 — shared domain logic for the command-line tools.

This module is the Python mirror of the balance rules in
``public/js/model.js`` (``classify`` and ``effects``). If you change how a
balance is derived in the app, change it here too, or the tools will start
disagreeing with the UI and you'll chase a phantom.

The rules, restated:

* Every ``amount`` is stored POSITIVE. Direction comes from which list the
  row is in (``transactions`` = money out, ``income`` = money in). A row
  with ``card == "Credit"`` is on the credit card; anything else is Flex.
* A row moves its own account: money out lowers it (on the card, the debt
  grows), money in raises it.
* A row's ``type`` is Spend, Refund, Income or Transfer. A Transfer names
  the other account in ``to`` (money out) or ``from`` (money in). A transfer
  between Flex and the card moves BOTH: paying the card off is one Flex row,
  "Transfer to Card", that lowers Flex AND shrinks the card debt. That's
  why transfers must never be counted as spending.
* Savings balances are typed in on the Accounts tab, so a transfer to or
  from Savings only moves Flex (or the card).
* Rows saved before types existed (before the restart) are read as they
  always were: money out in "Savings" is a transfer to savings, and money
  out in a category that isn't in ``categories`` (in practice "Credit") is
  a card repayment.

After the restart, ``meta.startDate`` is the budget's first day and the
opening balances are at the close of the day before it.
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

PENNY = 0.005

# money-in sources before the restart that were real income (model.js OLD_INCOME)
OLD_INCOME = ("Salary", "Presents", "Gifts")


def money(x: float) -> float:
    """Round to pence, killing the float dust that accumulates over 1000 rows."""
    return round(x + 1e-9, 2)


def account_of(row: dict) -> str:
    """The account a row is on: "Card" or "Flex"."""
    return "Card" if row.get("card") == "Credit" else "Flex"


def classify(row: dict, direction: str, categories) -> tuple[str, str | None, str | None]:
    """
    (type, category, other account) for a row; `direction` is "out" or "in".
    `categories` is only needed for rows saved before types existed.
    """
    kind = row.get("type")
    if kind:
        if kind == "Transfer":
            other = (row.get("from") if direction == "in" else row.get("to")) or row.get("to") or row.get("from")
            return "Transfer", None, other
        return kind, row.get("category"), None
    if direction == "out":
        cat = row.get("category")
        if cat == "Savings":
            return "Transfer", None, "Savings"
        if cat not in categories:
            return "Transfer", None, "Card"
        return "Spend", cat, None
    src = row.get("source")
    if src == "Savings":
        return "Transfer", None, "Savings"
    if src in OLD_INCOME:
        return "Income", src, None
    if src in ("Reimbursement", "Refund"):
        return "Refund", "Other", None
    if src and src in categories:
        return "Refund", src, None
    return "Income", src or "Other income", None


def effects(row: dict, direction: str, categories) -> dict[str, float]:
    """How a row moves the two tracked accounts: {"Flex": ±x, "Card": ±y}."""
    amt = float(row.get("amount") or 0)
    own = account_of(row)
    sign = -1 if direction == "out" else 1
    e = {"Flex": 0.0, "Card": 0.0}
    e[own] += sign * amt
    kind, _cat, other = classify(row, direction, categories)
    if kind == "Transfer" and other in ("Flex", "Card") and other != own:
        e[other] -= sign * amt
    return e


# --------------------------------------------------------------------------
# the budget document
# --------------------------------------------------------------------------

class Doc:
    """A loaded budget-data.json, with the app's balance rules attached."""

    def __init__(self, raw: dict):
        self.raw = raw
        self.transactions: list[dict] = raw.get("transactions", [])
        self.income: list[dict] = raw.get("income", [])
        self.categories: set[str] = set(raw.get("categories", []))
        self.accounts: dict = raw.get("accounts", {}) or {}

    @classmethod
    def load(cls, path: str | Path) -> "Doc":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.raw, indent=1, ensure_ascii=False), encoding="utf-8")

    @property
    def start_date(self) -> str | None:
        """The budget's first day once it has been restarted, else None."""
        return (self.raw.get("meta") or {}).get("startDate") or None

    def _all(self):
        for t in self.transactions:
            yield "out", t
        for i in self.income:
            yield "in", i

    def opening_flex(self) -> float:
        return float(self.accounts.get("openingFlex") or 0)

    def opening_credit(self) -> float:
        return float(self.accounts.get("openingCredit") or 0)

    # -- balances ----------------------------------------------------------

    def balances(self, as_of: str | None = None) -> tuple[float, float]:
        """(flex, credit) as the app would compute them, optionally up to a date."""
        flex, credit = self.opening_flex(), self.opening_credit()
        for direction, r in self._all():
            if as_of is not None and r.get("date", "") > as_of:
                continue
            e = effects(r, direction, self.categories)
            flex += e["Flex"]
            credit += e["Card"]
        return money(flex), money(credit)

    def rows_for(self, account: str) -> list[dict]:
        """
        Every row that moves `account` ("Debit" or "Credit"), normalised to
        {date, name, delta, kind, category, id}. `delta` is signed: negative
        reduces the balance (i.e. spending, or growing card debt).
        """
        acct = "Card" if account == "Credit" else "Flex"
        out: list[dict] = []
        for direction, r in self._all():
            e = effects(r, direction, self.categories)
            if e[acct] or account_of(r) == acct:
                out.append(_row(r, e[acct], direction, self.categories))
        out.sort(key=lambda r: (r["date"], -r["delta"]))
        return out


def _row(src: dict, delta: float, direction: str, categories) -> dict:
    kind, cat, other = classify(src, direction, categories)
    label = f"transfer {'to' if direction == 'out' else 'from'} {other or '?'}" if kind == "Transfer" else (cat or kind)
    return {
        "id": src.get("id"),
        "date": src.get("date", ""),
        "name": (src.get("name") or "").strip(),
        "delta": money(delta),
        "kind": kind,
        "category": label,
        "src": src,
    }


# --------------------------------------------------------------------------
# bank statement CSVs
# --------------------------------------------------------------------------

@dataclass
class StatementRow:
    date: str            # ISO
    description: str
    paid_out: float
    paid_in: float
    balance: float | None = None
    raw: dict = field(default_factory=dict)

    @property
    def delta(self) -> float:
        """Signed effect on the account balance."""
        return money(self.paid_in - self.paid_out)


@dataclass
class Statement:
    path: Path
    account_name: str
    account_type: str            # "Debit" | "Credit"
    stated_balance: float | None
    rows: list[StatementRow]
    downloaded: str | None = None   # ISO date parsed from the filename

    @property
    def has_running_balance(self) -> bool:
        return any(r.balance is not None for r in self.rows)

    @property
    def start(self) -> str | None:
        return min((r.date for r in self.rows), default=None)

    @property
    def end(self) -> str | None:
        return max((r.date for r in self.rows), default=None)


_MONEY_RE = re.compile(r"[^0-9.\-]")


def _num(s: str | None) -> float:
    """'£-2,296.30' / '\xa312.00' / '-£5.00' -> float. Blank -> 0.0."""
    if not s:
        return 0.0
    s = s.strip()
    if not s:
        return 0.0
    neg = "-" in s
    cleaned = _MONEY_RE.sub("", s).lstrip("-")
    if not cleaned:
        return 0.0
    v = float(cleaned)
    return -v if neg else v


_DATE_FORMATS = ("%d %b %Y", "%d/%m/%Y", "%Y-%m-%d", "%d %B %Y", "%d-%b-%Y")


def parse_date(s: str) -> str | None:
    s = (s or "").strip().strip('"')
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def read_text(path: Path) -> str:
    """
    The bank exports debit statements as UTF-8-with-BOM and credit
    statements as cp1252 (a bare 0xa3 for the pound sign). Guess, don't
    assume, or the credit files come back full of replacement characters.
    """
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


_FNAME_DATE = re.compile(r"(\d{4})-([A-Za-z]{3})-(\d{2})")


def _downloaded_from_name(path: Path) -> str | None:
    m = _FNAME_DATE.search(path.name)
    if not m:
        return None
    try:
        return datetime.strptime("-".join(m.groups()), "%Y-%b-%d").date().isoformat()
    except ValueError:
        return None


def parse_statement(path: str | Path) -> Statement:
    """Parse one downloaded statement CSV (either account's layout)."""
    path = Path(path)
    text = read_text(path)
    reader = csv.reader(io.StringIO(text))
    rows = [r for r in reader]

    account_name, stated = "", None
    header_idx, header = None, []

    for i, r in enumerate(rows):
        if not r:
            continue
        key = (r[0] or "").strip().lower().rstrip(":")
        if key == "account name" and len(r) > 1:
            account_name = r[1].strip()
        elif key == "account balance" and len(r) > 1:
            stated = _num(r[1])
        elif key == "date":
            header_idx, header = i, [c.strip().lower() for c in r]
            break

    if header_idx is None:
        raise ValueError(f"{path.name}: no 'Date' header row found")

    def col(*names):
        for n in names:
            if n in header:
                return header.index(n)
        return None

    i_date = col("date")
    i_desc = col("description", "transactions")
    i_loc = col("location")
    i_out = col("paid out")
    i_in = col("paid in")
    i_bal = col("balance")
    i_type = col("transaction type")

    account_type = "Credit" if "credit card" in account_name.lower() else "Debit"

    out: list[StatementRow] = []
    for r in rows[header_idx + 1:]:
        if not r or not (r[0] or "").strip():
            continue
        iso = parse_date(r[i_date]) if i_date is not None else None
        if not iso:
            continue

        def cell(idx):
            return r[idx].strip() if idx is not None and idx < len(r) else ""

        desc = cell(i_desc)
        loc = cell(i_loc)
        full = f"{desc} {loc}".strip() if loc else desc

        out.append(StatementRow(
            date=iso,
            description=full,
            paid_out=_num(cell(i_out)),
            paid_in=_num(cell(i_in)),
            balance=_num(cell(i_bal)) if i_bal is not None and cell(i_bal) else None,
            raw={"type": cell(i_type), "description": desc, "location": loc},
        ))

    return Statement(
        path=path,
        account_name=account_name,
        account_type=account_type,
        stated_balance=stated,
        rows=out,
        downloaded=_downloaded_from_name(path),
    )


def load_statements(folder: str | Path) -> list[Statement]:
    """
    Every *.csv in `folder` that is genuinely a downloaded bank statement.

    Other exports (transactions.csv, for instance) also start with a "Date"
    column, so the presence of the bank's "Account Name:" preamble is what
    actually distinguishes a statement.
    """
    found = []
    for p in sorted(Path(folder).glob("*.csv")):
        try:
            st = parse_statement(p)
        except ValueError:
            continue
        if st.account_name and st.rows:
            found.append(st)
    return found


# --------------------------------------------------------------------------
# credit-card PDF statements
# --------------------------------------------------------------------------

_PDF_TXN = re.compile(
    r"^(\d{2}/\d{2}/\d{2})\s+(\w+)\s+(.*?)\s*£\s*([\d,]+\.\d{2})\s*(CR)?$"
)

# The bank's newer PDFs extract with the spaces stripped out, the older ones
# don't. Matching against a whitespace-free copy of the text handles both.
_PDF_FIELDS = {
    "opening": re.compile(r"balancefrompreviousstatement£(-?[\d,]+\.\d{2})", re.I),
    "closing": re.compile(r"closingbalance£(-?[\d,]+\.\d{2})", re.I),
    "as_at": re.compile(r"summaryasat:?(\d{1,2}[a-z]+\d{4})", re.I),
}


def _pdf_date(s: str) -> str | None:
    """'24/08/26' -> '2026-08-24'."""
    try:
        return datetime.strptime(s, "%d/%m/%y").date().isoformat()
    except ValueError:
        return None


def _as_at_date(s: str) -> str | None:
    """'5September2026' / '05February2026' -> ISO."""
    m = re.match(r"(\d{1,2})([A-Za-z]+)(\d{4})", s or "")
    if not m:
        return None
    for fmt in ("%d%B%Y", "%d%b%Y"):
        try:
            return datetime.strptime("".join(m.groups()), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def parse_credit_pdf(path: str | Path) -> Statement:
    """
    Parse a Nationwide credit-card PDF statement.

    Unlike the CSV exports these are closed periods: they state the opening
    and closing balance, so each one is a self-contained check. `CR` marks a
    payment or refund (money off the card); everything else is a charge.
    """
    try:
        import pdfplumber
    except ImportError as e:                      # pragma: no cover
        raise RuntimeError("pdfplumber is required to read PDF statements: pip install pdfplumber") from e

    path = Path(path)
    with pdfplumber.open(path) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)

    flat = re.sub(r"\s+", "", text)
    def field(name):
        m = _PDF_FIELDS[name].search(flat)
        return m.group(1) if m else None

    opening = _num(field("opening"))
    closing = _num(field("closing"))
    as_at = _as_at_date(field("as_at") or "")

    rows: list[StatementRow] = []
    for line in text.splitlines():
        m = _PDF_TXN.match(line.strip())
        if not m:
            continue
        iso = _pdf_date(m.group(1))
        if not iso:
            continue
        amount = _num(m.group(4))
        is_credit = bool(m.group(5))
        rows.append(StatementRow(
            date=iso,
            description=re.sub(r"\s+", " ", m.group(3)).strip(),
            paid_out=0.0 if is_credit else amount,
            paid_in=amount if is_credit else 0.0,
            raw={"ref": m.group(2), "source": path.name},
        ))
    rows.sort(key=lambda r: r.date)

    st = Statement(
        path=path,
        account_name="Member Credit Card",
        account_type="Credit",
        stated_balance=-closing if closing else None,
        rows=rows,
        downloaded=as_at,
    )
    # Card statements quote what you OWE as a positive number; the app holds
    # it as a negative balance. Keep both on the app's convention.
    st.opening_balance = -opening if opening is not None else None   # type: ignore[attr-defined]
    st.as_at = as_at                                                  # type: ignore[attr-defined]
    return st


def load_credit_pdfs(folder: str | Path) -> list[Statement]:
    out = []
    for p in sorted(Path(folder).rglob("*.pdf")):
        try:
            st = parse_credit_pdf(p)
        except Exception:
            continue
        if st.rows or st.stated_balance is not None:
            out.append(st)
    out.sort(key=lambda s: s.as_at or "")          # type: ignore[attr-defined]
    return out


def merge_statements(sts: list[Statement]) -> list[StatementRow]:
    """
    Combine several period exports into one ledger.

    The bank's exports can overlap, so a transaction may appear in two
    files. Summing would double-count it; dropping all repeats would lose
    genuine same-day duplicates (two identical rounds at the same pub, say).
    Taking the HIGHEST count any single export reports for a given
    (date, amount, description) preserves real duplicates while collapsing
    the overlap.
    """
    from collections import Counter

    best: Counter = Counter()
    keep: dict[tuple, StatementRow] = {}
    for s in sts:
        seen: Counter = Counter()
        for r in s.rows:
            k = (r.date, round(r.delta, 2), r.description)
            seen[k] += 1
            keep.setdefault(k, r)
        for k, v in seen.items():
            best[k] = max(best[k], v)

    out: list[StatementRow] = []
    for k, n in best.items():
        out.extend([keep[k]] * n)
    out.sort(key=lambda r: r.date)
    return out


# --------------------------------------------------------------------------
# matching helpers
# --------------------------------------------------------------------------

_NOISE = re.compile(r"\b(gb|google|pay|contactless|payment|visa|purchase)\b|\d{4,}|[^a-z ]")


def norm_name(s: str) -> str:
    """Loose merchant key: lowercase, strip card-network noise and digits."""
    s = (s or "").lower()
    s = _NOISE.sub(" ", s)
    return " ".join(s.split())


def days_between(a: str, b: str) -> int:
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def add_days(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def checking_from(doc: Doc, since: str | None) -> str | None:
    """
    The first day to compare. A restarted budget holds nothing before its
    start date (the opening balances cover it), so never earlier than that.
    """
    start = doc.start_date
    if start and (not since or since < start):
        return start
    return since
