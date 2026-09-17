#!/usr/bin/env python3
"""
Import a FlexGraduate / credit-card statement CSV into Budget 2026 v2.xlsx.

    python import_statement.py "Statement Download 2026-Jul-21 20-11-14.csv"
    python import_statement.py statement.csv --card Credit
    python import_statement.py statement.csv --dry-run

Paid out  -> Transactions
Paid in   -> Income
Merchants are matched against the rules on the Setup sheet. Anything that does
not match is still imported, categorised "Other", and highlighted red for review.
Rows already in the workbook are skipped, so re-running is safe.
"""
import argparse, csv, datetime, re, sys
from pathlib import Path

import openpyxl
from openpyxl.styles import Font, PatternFill

WB = "Budget 2026 v2.xlsx"
GBP = ('_([$£-en-GB]* #,##0.00_);_([$£-en-GB]* (#,##0.00);'
       '_([$£-en-GB]* "-"??_);_(@_)')
FLAG_FILL = PatternFill("solid", fgColor="F4CCCC")
FLAG_FONT = Font(name="Arial", size=11, color="CC0000")
BODY = Font(name="Arial", size=11)

# Net-zero / internal movements that do not belong in either sheet.
SKIP = re.compile(
    r"transfer to|transfer from|to saver|from saver|returned direct debit|"
    r"^payment received|^direct debit returned",
    re.I,
)


def money(v):
    if v is None:
        return 0.0
    s = re.sub(r"[^0-9.\-]", "", str(v).replace("�", "").replace("£", ""))
    try:
        return round(float(s), 2)
    except ValueError:
        return 0.0


def parse_date(s):
    s = (s or "").strip().strip('"')
    for fmt in ("%d %b %Y", "%d/%m/%Y", "%Y-%m-%d", "%d %B %Y"):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def read_statement(path):
    """Return (rows, stated_balance). Handles the preamble before the header."""
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    lines = text.splitlines()

    balance, start = None, None
    for i, line in enumerate(lines):
        if balance is None and "Account Balance" in line:
            m = re.search(r"-?[\d,]+\.\d\d", line)
            if m:
                balance = float(m.group().replace(",", ""))
        if line.strip().startswith('"Date"'):
            start = i
            break
    if start is None:
        sys.exit("Could not find the header row (a line starting with \"Date\").")

    rdr = csv.DictReader(lines[start:])
    rows = []
    for r in rdr:
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        d = parse_date(r.get("Date"))
        if not d:
            continue
        desc = (r.get("Description") or r.get("Transactions") or "").strip()
        loc = (r.get("Location") or "").strip()
        if loc and loc.lower() not in desc.lower():
            desc = f"{desc} {loc}".strip()
        rows.append({
            "date": d,
            "desc": re.sub(r"\s+", " ", desc),
            "out": money(r.get("Paid out")),
            "in": money(r.get("Paid in")),
        })
    return rows, balance


def load_rules(wb):
    st = wb["Setup"]
    rules = []
    for row in st.iter_rows(min_row=5, min_col=9, max_col=10, values_only=True):
        if row[0] and row[1]:
            rules.append((str(row[0]).lower(), str(row[1])))
    rules.sort(key=lambda x: -len(x[0]))
    return rules


def categorise(desc, rules):
    d = desc.lower()
    for pat, cat in rules:
        if pat in d:
            return cat, True
    return "Other", False


def existing_keys(ws, amount_col, name_col):
    """Date + amount only.

    Deliberately NOT keyed on the description. The statement calls a thing
    "TENPIN LIMITED CAMBRIDGE GB" where the workbook says "Bowling", so
    including the name would treat almost every historical row as new and
    duplicate the entire year. Same date and same amount is the reliable
    identity. Two genuinely distinct charges of the same amount on the same
    day collapse into one - rare, and reported below so you can re-add it.
    """
    keys = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if isinstance(row[0], datetime.datetime):
            k = (row[0].date(), round(float(row[amount_col] or 0), 2))
            keys[k] = keys.get(k, 0) + 1
    return keys


def take_match(keys, date, amount, window):
    """Consume a matching key within +/- window days. Cards settle a day or
    three after you spend, so the workbook date and the statement date often
    differ. Nearest date wins."""
    cands = []
    for off in range(-window, window + 1):
        k = (date + datetime.timedelta(days=off), amount)
        if keys.get(k, 0) > 0:
            cands.append((abs(off), k))
    if not cands:
        return False
    keys[min(cands)[1]] -= 1
    return True


def latest_date(ws):
    best = None
    for row in ws.iter_rows(min_row=2, values_only=True):
        if isinstance(row[0], datetime.datetime):
            if best is None or row[0] > best:
                best = row[0]
    return best


def last_row(ws):
    last = 1
    for row in ws.iter_rows(min_row=2):
        if isinstance(row[0].value, datetime.datetime):
            last = row[0].row
    return last


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("statement")
    ap.add_argument("--workbook", default=WB)
    ap.add_argument("--card", default="Debit", choices=["Debit", "Credit"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--since", metavar="DD/MM/YYYY",
                    help="only import rows after this date "
                         "(default: the last date already in the workbook)")
    ap.add_argument("--all", action="store_true",
                    help="ignore the cutoff and consider every statement row")
    ap.add_argument("--window", type=int, default=3,
                    help="settlement-lag tolerance in days (default 3)")
    a = ap.parse_args()

    rows, balance = read_statement(a.statement)
    wb = openpyxl.load_workbook(a.workbook)
    rules = load_rules(wb)
    tx, inc = wb["Transactions"], wb["Income"]

    tx_keys = existing_keys(tx, 3, 4)
    inc_keys = existing_keys(inc, 3, 4)

    cutoff = None
    if not a.all:
        if a.since:
            cutoff = parse_date(a.since)
        else:
            cutoff = latest_date(tx)
        if cutoff:
            cutoff = cutoff - datetime.timedelta(days=a.window)

    before = len(rows)
    if cutoff:
        rows = [r for r in rows if r["date"] > cutoff]

    new_tx, new_inc, skipped, dupes = [], [], 0, 0
    for r in rows:
        if SKIP.search(r["desc"]):
            skipped += 1
            continue
        if r["out"] > 0:
            if take_match(tx_keys, r["date"].date(), r["out"], a.window):
                dupes += 1
                continue
            cat, matched = categorise(r["desc"], rules)
            new_tx.append((r, cat, matched))
        elif r["in"] > 0:
            if take_match(inc_keys, r["date"].date(), r["in"], a.window):
                dupes += 1
                continue
            new_inc.append(r)

    print(f"statement rows      {before}")
    if cutoff:
        print(f"before cutoff       {before - len(rows)}  "
              f"(cutoff {cutoff:%d/%m/%Y}, use --all to override)")
    print(f"already in workbook {dupes}")
    print(f"internal transfers  {skipped}")
    print(f"new transactions    {len(new_tx)}")
    print(f"new income          {len(new_inc)}")
    unmatched = [t for t in new_tx if not t[2]]
    if unmatched:
        print(f"\nneeds a category ({len(unmatched)}) - imported as Other, flagged red:")
        for r, cat, _ in unmatched:
            print(f"  {r['date']:%d %b}  £{r['out']:>8.2f}  {r['desc'][:52]}")

    if a.dry_run:
        print("\ndry run - nothing written")
        return

    r0 = last_row(tx) + 1
    for i, (r, cat, matched) in enumerate(new_tx):
        rr = r0 + i
        tx.cell(row=rr, column=1, value=r["date"]).number_format = "DD/MM/YYYY"
        tx.cell(row=rr, column=2, value=f'=IF($A{rr}="","",WEEKNUM($A{rr},21))')
        tx.cell(row=rr, column=3, value=f'=IF($A{rr}="","",MONTH($A{rr}))')
        tx.cell(row=rr, column=4, value=r["out"]).number_format = GBP
        tx.cell(row=rr, column=5, value=r["desc"][:80])
        c = tx.cell(row=rr, column=6, value=cat)
        tx.cell(row=rr, column=7, value=a.card)
        for col in range(1, 8):
            tx.cell(row=rr, column=col).font = BODY
        if not matched:
            c.fill, c.font = FLAG_FILL, FLAG_FONT
            c.comment = openpyxl.comments.Comment(
                f"No rule matched '{r['desc'][:60]}'. Guessed Other.\n"
                "Set the right category, then add the merchant to Setup!I:J.",
                "import_statement.py")

    r0 = last_row(inc) + 1
    for i, r in enumerate(new_inc):
        rr = r0 + i
        inc.cell(row=rr, column=1, value=r["date"]).number_format = "DD/MM/YYYY"
        inc.cell(row=rr, column=2, value=f'=IF($A{rr}="","",WEEKNUM($A{rr},21))')
        inc.cell(row=rr, column=3, value=f'=IF($A{rr}="","",MONTH($A{rr}))')
        inc.cell(row=rr, column=4, value=r["in"]).number_format = GBP
        inc.cell(row=rr, column=5, value=r["desc"][:80])
        inc.cell(row=rr, column=6, value="Other")
        for col in range(1, 7):
            inc.cell(row=rr, column=col).font = BODY

    wb.save(a.workbook)
    print(f"\nwritten to {a.workbook}")
    if balance is not None:
        print(f"statement balance   £{balance:,.2f}")
        print("Open the workbook, let it recalculate, and check Accounts!B7 agrees.")


if __name__ == "__main__":
    main()
