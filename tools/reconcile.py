#!/usr/bin/env python3
"""
Budget 2026 — reconcile the app against downloaded bank statements.

The debit statements carry a running Balance column, which makes this much
more useful than a single end-of-period check: we can walk the statement
day by day, compare it to what the app thinks, and name the exact day the
two stopped agreeing — then list the rows responsible.

    python3 tools/reconcile.py local/budget-data.json \
        --statements local/statements

Options:
    --account Debit|Credit   only check one account
    --from YYYY-MM-DD        ignore anything before this date
    --verbose                show every day, not just the broken ones
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from budget_lib import (  # noqa: E402
    Doc, Statement, StatementRow, days_between, load_credit_pdfs,
    load_statements, merge_statements, money, norm_name, parse_statement,
)

BOLD, DIM, RED, GRN, YEL, CYN, OFF = (
    "\033[1m", "\033[2m", "\033[31m", "\033[32m", "\033[33m", "\033[36m", "\033[0m"
)


def hdr(s: str) -> None:
    print(f"\n{BOLD}{s}{OFF}\n" + "─" * min(len(s), 78))


# --------------------------------------------------------------------------


def statement_daily(st: Statement) -> dict[str, float]:
    """Closing balance per day, taken from the statement's own Balance column."""
    out: dict[str, float] = {}
    for r in st.rows:
        if r.balance is not None:
            out[r.date] = r.balance          # later rows win = end of that day
    return out


def app_daily(doc: Doc, account: str, days: list[str]) -> dict[str, float]:
    """What the app's balance would be at the close of each of `days`."""
    rows = doc.rows_for(account)
    opening = doc.opening_flex() if account == "Debit" else doc.opening_credit()
    out, running, i = {}, opening, 0
    for d in sorted(days):
        while i < len(rows) and rows[i]["date"] <= d:
            running += rows[i]["delta"]
            i += 1
        out[d] = money(running)
    return out


def compare_running(doc: Doc, st: Statement, since: str | None, verbose: bool) -> dict:
    """Walk one statement and find where the app diverges."""
    sday = statement_daily(st)
    days = sorted(d for d in sday if not since or d >= since)
    if not days:
        return {}

    aday = app_daily(doc, st.account_type, days)

    rows = []
    first_break = None
    prev_diff = None
    for d in days:
        diff = money(aday[d] - sday[d])
        step = None if prev_diff is None else money(diff - prev_diff)
        broke = abs(diff) >= 0.01
        if broke and first_break is None:
            first_break = d
        rows.append({"date": d, "stmt": sday[d], "app": aday[d], "diff": diff, "step": step})
        prev_diff = diff

    shown = rows if verbose else [r for r in rows if r["step"] not in (None, 0.0) or r is rows[-1]]

    print(f"{DIM}{st.path.name}{OFF}")
    print(f"  {st.account_name}  ·  {st.start} → {st.end}  ·  {len(st.rows)} rows")
    if not first_break:
        print(f"  {GRN}✓ agrees with the app on every day in this statement{OFF}")
        return {"ok": True, "statement": st}

    print(f"  {RED}✗ first disagreement on {first_break}{OFF}")
    print(f"\n  {'date':<12}{'statement':>12}{'app':>12}{'diff':>11}{'moved by':>11}")
    for r in shown[:40]:
        colour = RED if abs(r["diff"]) >= 0.01 else GRN
        step = "" if r["step"] in (None, 0.0) else f"{r['step']:+.2f}"
        print(f"  {r['date']:<12}{r['stmt']:>12.2f}{colour}{r['app']:>12.2f}"
              f"{r['diff']:>11.2f}{OFF}{YEL}{step:>11}{OFF}")
    if len(shown) > 40:
        print(f"  {DIM}… {len(shown)-40} more days{OFF}")

    return {"ok": False, "statement": st, "first_break": first_break, "rows": rows}


# --------------------------------------------------------------------------


def explain_day(doc: Doc, st: Statement, day: str) -> None:
    """Line-by-line diff of one day: what the bank says vs what the app holds."""
    bank = [r for r in st.rows if r.date == day]
    app = [r for r in doc.rows_for(st.account_type) if r["date"] == day]

    print(f"\n  {BOLD}{day}{OFF} — bank has {len(bank)}, app has {len(app)}")

    # Match on signed amount, then fall back to merchant name.
    pool = list(app)
    matched_app = set()
    print(f"    {DIM}bank side{OFF}")
    for b in bank:
        want = b.delta
        hit = next((a for a in pool if id(a) not in matched_app and abs(a["delta"] - want) < 0.005), None)
        if hit:
            matched_app.add(id(hit))
            print(f"      {GRN}✓{OFF} {want:>9.2f}  {b.description[:52]}")
        else:
            print(f"      {RED}MISSING in app{OFF} {want:>9.2f}  {b.description[:44]}")

    extra = [a for a in pool if id(a) not in matched_app]
    if extra:
        print(f"    {DIM}only in the app (not on the statement){OFF}")
        for a in extra:
            print(f"      {YEL}EXTRA{OFF} {a['delta']:>9.2f}  {a['name'][:44]}  {DIM}[{a['category']}] {a['id']}{OFF}")


def summarise_missing(doc: Doc, st: Statement, since: str | None) -> None:
    """Whole-statement view: rows the bank has that the app doesn't, and vice versa."""
    bank = [r for r in st.rows if not since or r.date >= since]
    app = [r for r in doc.rows_for(st.account_type)
           if (not since or r["date"] >= since) and st.start <= r["date"] <= st.end]

    b_keys: dict[tuple, list] = defaultdict(list)
    for r in bank:
        b_keys[(r.date, round(r.delta, 2))].append(r)

    a_keys: dict[tuple, list] = defaultdict(list)
    for r in app:
        a_keys[(r["date"], round(r["delta"], 2))].append(r)

    missing, extra = [], []
    for k, rows in b_keys.items():
        have = len(a_keys.get(k, []))
        for r in rows[have:]:
            missing.append(r)
    for k, rows in a_keys.items():
        have = len(b_keys.get(k, []))
        for r in rows[have:]:
            extra.append(r)

    if missing:
        print(f"\n  {RED}On the statement but NOT in the app ({len(missing)}, "
              f"net {money(sum(r.delta for r in missing)):+.2f}){OFF}")
        for r in sorted(missing, key=lambda r: r.date):
            print(f"    {r.date}  {r.delta:>9.2f}  {r.description[:56]}")

    if extra:
        print(f"\n  {YEL}In the app but NOT on the statement ({len(extra)}, "
              f"net {money(sum(r['delta'] for r in extra)):+.2f}){OFF}")
        for r in sorted(extra, key=lambda r: r["date"]):
            print(f"    {r['date']}  {r['delta']:>9.2f}  {r['name'][:46]}  {DIM}[{r['category']}]{OFF}")

    if not missing and not extra:
        print(f"\n  {GRN}Every line matches.{OFF}")


# --------------------------------------------------------------------------


def credit_check(doc: Doc, sts: list[Statement], pdf_folder: str | None, verbose: bool) -> None:
    """
    Reconcile the credit card.

    Preferred source is the set of period CSV exports: they carry the
    TRANSACTION date, which is the convention the app uses, and they merge
    into one complete ledger. The PDFs carry the POSTING date instead, so
    they are used only for their stated closing balances — comparing rows
    against them produces phantom "differences" that are really just the
    few days between spending and settling.
    """
    pdfs = load_credit_pdfs(pdf_folder) if pdf_folder and Path(pdf_folder).exists() else []

    if sts:
        hdr("Credit card — full ledger, against the statement exports")
        bank = merge_statements(sts)
        hi = max(r.date for r in bank)
        app = [r for r in doc.rows_for("Credit") if r["date"] <= hi]

        b_net = money(sum(r.delta for r in bank))
        a_net = money(sum(r["delta"] for r in app))
        opening = doc.opening_credit()

        print(f"  {len(sts)} exports merged into {len(bank)} rows, "
              f"{min(r.date for r in bank)} → {hi}")
        print(f"  bank movement {b_net:>10.2f}   app movement {a_net:>10.2f}   "
              f"diff {money(a_net-b_net):>+9.2f}")
        print(f"  bank balance  {money(opening+b_net):>10.2f}   "
              f"app balance  {money(opening+a_net):>10.2f}   as at {hi}\n")

        missing, extra = _match_loose(app, bank, window=7)
        if not missing and not extra:
            print(f"  {GRN}✓ every one of the {len(bank)} card transactions matches{OFF}")
        else:
            if extra:
                print(f"  {YEL}In the app, not on the card ({len(extra)}, "
                      f"net {money(sum(r['delta'] for r in extra)):+.2f}){OFF}")
                for r in extra:
                    print(f"    {r['date']}  {r['delta']:>9.2f}  {r['name'][:44]}  "
                          f"{DIM}[{r['category']}] {r['id']}{OFF}")
            if missing:
                print(f"  {RED}On the card, not in the app ({len(missing)}, "
                      f"net {money(sum(r.delta for r in missing)):+.2f}){OFF}")
                for r in missing:
                    print(f"    {r.date}  {r.delta:>9.2f}  {r.description[:52]}")

        # Anything after the last statement row can't be checked — but it is
        # exactly where an in-flight card payment shows up, so call it out.
        tail = [r for r in doc.rows_for("Credit") if r["date"] > hi]
        if tail:
            print(f"\n  {DIM}Not yet on any statement (after {hi}):{OFF}")
            for r in tail:
                note = "  ← payment still in flight" if r["delta"] > 0 else ""
                print(f"    {r['date']}  {r['delta']:>9.2f}  {r['name'][:40]}{CYN}{note}{OFF}")
            live = [s.stated_balance for s in sts if s.stated_balance is not None]
            if live:
                print(f"\n  bank's live balance {live[0]:>10.2f}   "
                      f"app {doc.balances()[1]:>10.2f}   "
                      f"diff {money(doc.balances()[1]-live[0]):>+9.2f}")

    if pdfs:
        hdr("Credit card — closing balance per PDF statement")
        for st in pdfs:
            end = st.as_at                                    # type: ignore[attr-defined]
            if not end:
                continue
            app_close = doc.balances(as_of=end)[1]
            diff = money(app_close - st.stated_balance)
            mark = f"{GRN}✓{OFF}" if abs(diff) < 0.01 else f"{YEL}~{OFF}"
            print(f"{mark} {st.path.name:<24} as at {end}   "
                  f"statement {st.stated_balance:>10.2f}   app {app_close:>10.2f}   "
                  f"diff {diff:>+9.2f}")
        print(f"\n  {DIM}A small difference here is normal: PDFs date a transaction when it"
              f"\n  settles, the app (and the CSV exports) when you actually spent it.{OFF}")


def _match_loose(app: list[dict], bank: list[StatementRow], window: int):
    """Pair app rows to bank rows on amount, tolerating a few days of drift."""
    pool = sorted(bank, key=lambda r: r.date)
    used: set[int] = set()
    extra = []
    for a in sorted(app, key=lambda r: r["date"]):
        hit = None
        for i, b in enumerate(pool):
            if i in used or abs(b.delta - a["delta"]) > 0.005:
                continue
            if days_between(a["date"], b.date) <= window:
                hit = i
                break
        if hit is None:
            extra.append(a)
        else:
            used.add(hit)
    missing = [b for i, b in enumerate(pool) if i not in used]
    return missing, extra


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("doc", nargs="?", default="local/budget-data.json")
    ap.add_argument("--statements", default="local/statements")
    ap.add_argument("--pdfs", default="local/statements/credit-card-pdfs")
    ap.add_argument("--credit", default="local/statements/credit-statements",
                    help="folder of credit-card CSV exports")
    ap.add_argument("--account", choices=["Debit", "Credit"])
    ap.add_argument("--from", dest="since")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--explain", metavar="YYYY-MM-DD", help="line-by-line diff for one day")
    a = ap.parse_args()

    doc = Doc.load(a.doc)
    sts = load_statements(a.statements)
    if not sts:
        print(f"No statements found in {a.statements}", file=sys.stderr)
        return 1

    flex, credit = doc.balances()
    hdr("Where the app thinks you are, right now")
    print(f"  Flex (debit)  {flex:>12.2f}")
    print(f"  Credit card   {credit:>12.2f}")
    print(f"  {DIM}{len(doc.transactions)} spending rows · {len(doc.income)} income rows{OFF}")

    if a.credit and Path(a.credit).exists():
        sts += [s for s in load_statements(a.credit) if s.path.parent != Path(a.statements)]
    debit = [s for s in sts if s.account_type == "Debit"]
    cred = [s for s in sts if s.account_type == "Credit"]

    if a.account != "Credit" and debit:
        hdr("Flex / debit — day-by-day against the statement balance")
        newest = max(debit, key=lambda s: (s.end or "", len(s.rows)))
        for st in sorted(debit, key=lambda s: s.end or ""):
            res = compare_running(doc, st, a.since, a.verbose)
            if res and not res.get("ok") and st is newest:
                summarise_missing(doc, st, a.since)
            print()

        if a.explain:
            explain_day(doc, newest, a.explain)

    if a.account != "Debit":
        credit_check(doc, cred, a.pdfs, a.verbose)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
