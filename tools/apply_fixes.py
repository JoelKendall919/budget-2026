#!/usr/bin/env python3
"""
Budget 2026 — apply reconciliation corrections to budget-data.json.

`reconcile.py` tells you what disagrees. This applies the fix, and refuses
to do anything that doesn't end with the app matching the bank exactly.

It classifies each discrepancy before acting, because "app has a row the
bank doesn't" has two very different causes:

  * DATE SHIFT   — the same merchant and amount appears on both sides a few
                   days apart. The transaction is real; only its date is
                   wrong. We move it, keeping its id, category and splits.
  * DUPLICATE    — the app has a row the bank has no counterpart for at all.
                   It was imported twice. We delete it.
  * MISSING      — the bank has a row the app doesn't. We add it, using your
                   rules to categorise, flagged for review.

Nothing is written unless you pass --write, and a timestamped backup is
taken first.

    python3 tools/apply_fixes.py                      # dry run
    python3 tools/apply_fixes.py --write              # actually do it
    python3 tools/apply_fixes.py --write --window 6   # looser date matching
"""

from __future__ import annotations

import argparse
import shutil
import sys
import time
from collections import defaultdict
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from budget_lib import (  # noqa: E402
    Doc, Statement, StatementRow, load_statements, money, norm_name,
)

BOLD, DIM, RED, GRN, YEL, CYN, OFF = (
    "\033[1m", "\033[2m", "\033[31m", "\033[32m", "\033[33m", "\033[36m", "\033[0m"
)


def similar(a: str, b: str) -> float:
    a, b = norm_name(a), norm_name(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


# --------------------------------------------------------------------------


def diff_against(doc: Doc, st: Statement, since: str | None):
    """Rows on the statement the app lacks, and rows the app has the bank lacks."""
    lo = max(st.start, since) if since else st.start
    bank = [r for r in st.rows if lo <= r.date <= st.end]
    app = [r for r in doc.rows_for(st.account_type) if lo <= r["date"] <= st.end]

    b_keys: dict[tuple, list] = defaultdict(list)
    for r in bank:
        b_keys[(r.date, round(r.delta, 2))].append(r)
    a_keys: dict[tuple, list] = defaultdict(list)
    for r in app:
        a_keys[(r["date"], round(r["delta"], 2))].append(r)

    missing = [r for k, rows in b_keys.items() for r in rows[len(a_keys.get(k, [])):]]
    extra = [r for k, rows in a_keys.items() for r in rows[len(b_keys.get(k, [])):]]
    return missing, extra


def classify(missing: list[StatementRow], extra: list[dict], window: int):
    """
    Pair up (extra, missing) that are plainly the same transaction on a
    different date, so we move rather than delete-and-recreate.
    """
    moves, used_m, used_e = [], set(), set()
    candidates = []
    for ei, e in enumerate(extra):
        for mi, m in enumerate(missing):
            if abs(e["delta"] - m.delta) > 0.005:
                continue
            gap = abs((date.fromisoformat(e["date"]) - date.fromisoformat(m.date)).days)
            if gap > window:
                continue
            score = similar(e["name"], m.description)
            if score >= 0.6:
                candidates.append((-score, gap, ei, mi))

    for _score, _gap, ei, mi in sorted(candidates):
        if ei in used_e or mi in used_m:
            continue
        used_e.add(ei)
        used_m.add(mi)
        moves.append((extra[ei], missing[mi]))

    dupes = [e for i, e in enumerate(extra) if i not in used_e]
    adds = [m for i, m in enumerate(missing) if i not in used_m]
    return moves, dupes, adds


# --------------------------------------------------------------------------


def categorise(doc: Doc, text: str) -> str | None:
    """Apply the app's merchant rules (longest match first, as app.js does)."""
    t = (text or "").lower()
    for r in sorted(doc.raw.get("rules", []), key=lambda r: -len(r.get("match", ""))):
        m = (r.get("match") or "").lower()
        if m and m in t:
            return r.get("category")
    return None


def apply_move(row: dict, target: StatementRow) -> None:
    row["src"]["date"] = target.date


def apply_delete(doc: Doc, row: dict) -> None:
    rid = row["id"]
    doc.raw["transactions"] = [t for t in doc.raw["transactions"] if t.get("id") != rid]
    doc.raw["income"] = [i for i in doc.raw["income"] if i.get("id") != rid]


def apply_add(doc: Doc, r: StatementRow, card: str, n: int) -> dict:
    new_id = f"fix{int(time.time())}_{n}"
    if r.paid_out > 0:
        cat = categorise(doc, r.description)
        row = {
            "id": new_id, "date": r.date, "amount": money(r.paid_out),
            "name": r.description, "category": cat or "Other", "card": card,
            "flagged": cat is None, "confirmed": False,
        }
        doc.raw["transactions"].append(row)
    else:
        src = categorise(doc, r.description)
        row = {
            "id": new_id, "date": r.date, "amount": money(r.paid_in),
            "name": r.description, "source": src or "Other", "card": card,
            "flagged": src is None, "confirmed": False,
        }
        doc.raw["income"].append(row)
    return row


# --------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("doc", nargs="?", default="local/budget-data.json")
    ap.add_argument("--statements", default="local/statements")
    ap.add_argument("--from", dest="since", help="ignore anything before this date")
    ap.add_argument("--window", type=int, default=4, help="days apart still considered the same transaction")
    ap.add_argument("--write", action="store_true", help="apply the changes (default is a dry run)")
    a = ap.parse_args()

    doc = Doc.load(a.doc)
    sts = [s for s in load_statements(a.statements) if s.account_type == "Debit"]
    if not sts:
        print("No debit statements found.", file=sys.stderr)
        return 1

    st = max(sts, key=lambda s: (s.end or "", len(s.rows)))
    print(f"{BOLD}Reconciling against{OFF} {st.path.name}")
    print(f"{DIM}{st.account_name} · {st.start} → {st.end} · {len(st.rows)} rows{OFF}\n")

    before = doc.balances()[0]
    target = st.stated_balance
    print(f"  app now      {before:>10.2f}")
    print(f"  bank says    {target:>10.2f}")
    print(f"  difference   {money(before-target):>+10.2f}\n")

    missing, extra = diff_against(doc, st, a.since)
    moves, dupes, adds = classify(missing, extra, a.window)

    if not (moves or dupes or adds):
        print(f"{GRN}Nothing to fix.{OFF}")
        return 0

    if moves:
        print(f"{CYN}{BOLD}Date corrections{OFF} {DIM}(same transaction, wrong day){OFF}")
        for e, m in moves:
            print(f"  {e['date']} → {m.date}   {e['delta']:>9.2f}  {e['name'][:44]}")
            print(f"     {DIM}bank: {m.description[:60]}{OFF}")
        print()

    if dupes:
        print(f"{RED}{BOLD}Delete — in the app, nowhere on the statement{OFF}")
        for e in dupes:
            print(f"  {e['date']}  {e['delta']:>9.2f}  {e['name'][:44]}  {DIM}[{e['category']}] {e['id']}{OFF}")
        print()

    if adds:
        print(f"{GRN}{BOLD}Add — on the statement, missing from the app{OFF}")
        for m in adds:
            cat = categorise(doc, m.description) or "Other (needs review)"
            print(f"  {m.date}  {m.delta:>9.2f}  {m.description[:44]}  {DIM}→ {cat}{OFF}")
        print()

    # -- what the balance will be afterwards -------------------------------
    delta = money(sum(m.delta for m in adds) - sum(e["delta"] for e in dupes))
    projected = money(before + delta)
    ties = abs(projected - target) < 0.01

    print(f"{BOLD}After these changes{OFF}")
    print(f"  app becomes  {projected:>10.2f}")
    print(f"  bank says    {target:>10.2f}")
    if ties:
        print(f"  {GRN}✓ ties exactly{OFF}\n")
    else:
        print(f"  {RED}✗ still out by {money(projected-target):+.2f}{OFF}\n")

    if not a.write:
        print(f"{DIM}Dry run — nothing written. Re-run with --write to apply.{OFF}")
        return 0

    if not ties:
        print(f"{RED}Refusing to write: the corrections don't reconcile. "
              f"Investigate with reconcile.py first.{OFF}")
        return 2

    # -- write -------------------------------------------------------------
    src = Path(a.doc)
    backup = src.with_name(f"{src.stem}.backup-{time.strftime('%Y%m%d-%H%M%S')}{src.suffix}")
    shutil.copy2(src, backup)
    print(f"{DIM}Backup: {backup.name}{OFF}")

    for e, m in moves:
        apply_move(e, m)
    for e in dupes:
        apply_delete(doc, e)
    for n, m in enumerate(adds):
        apply_add(doc, m, st.account_type, n)

    doc.raw.setdefault("transactions", []).sort(key=lambda t: t.get("date", ""))
    doc.raw.setdefault("income", []).sort(key=lambda t: t.get("date", ""))
    doc.save(src)

    check = Doc.load(src).balances()[0]
    print(f"\n{BOLD}Written.{OFF} App balance is now {check:.2f} "
          f"(bank {target:.2f}).")
    if abs(check - target) < 0.01:
        print(f"{GRN}✓ reconciled{OFF}")
        return 0
    print(f"{RED}✗ still out by {money(check-target):+.2f} — restore {backup.name}{OFF}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
