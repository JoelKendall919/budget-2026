# Plan: pay-period budgeting, simpler Bills & Budget, restart from 18 Sep 2026

**Status:** agreed 21 Oct 2026 — being built on this branch (progress in section 7)
**Branch:** `joelkendall919-pay-period-budgeting`

---

## 1. Goal

- Budget by **pay period** (paid every 4 weeks), while bills stay **monthly** (or yearly).
- Replace today's Budget tab (Monthly / Yearly bills / Reconcile) with two simple tabs: **Bills** and **Budget**.
- **Restart** the live budget from payday **Fri 18 Sep 2026**; everything earlier is archived, not deleted.
- Automatic by default, but **anything can be overridden by hand**, and a manual choice always wins.

---

## 2. Agreed decisions

| # | Decision |
|---|----------|
| D1 | Paydays every 28 days from Fri 18 Sep 2026: 16 Oct, 13 Nov, 11 Dec, 8 Jan … |
| D2 | A pay period runs payday → day before next payday (e.g. 16 Oct – 12 Nov). |
| D3 | A period's bills budget = the bills **actually due** in it. The smoothed average (monthly × 12/13) is shown for reference only. |
| D4 | Data before 18 Sep is **archived** (kept in Supabase + downloaded as JSON), not deleted. |
| D5 | Two tabs: **Bills** (what must I pay, has it gone out?) and **Budget** (what can I spend, how am I doing?). |
| D6 | Bill due dates are **set by you** — no guessing from history. |
| D7 | Overrides allowed for: budgets per period, bill matching, bill amount/date per occurrence, payday dates, and which period a transaction counts in. |
| D8 | Every ledger row gets a **type** (Spend / Refund / Income / Transfer) as well as a category, and the categories are tidied up (see 3.7). |

---

## 3. How it will work

### 3.1 Pay periods
- The app works out every payday from 18 Sep + 28 days.
- **Override:** move a single payday (e.g. paid Thu 10 Dec before a bank holiday). Only that boundary moves; the 28-day rhythm carries on from the normal date afterwards.
- Because there are 13 paydays a year and 12 monthly bills, each monthly bill skips one period a year. Example: rent due on the 1st has no due date in **2 Apr – 29 Apr 2027**. The Budget tab will point this out ("Rent not due this period").

### 3.2 Bills tab

One list, all bills together (monthly and yearly). The credit-card repayment also appears as a **reminder** (due date + statement amount, ✅ when the transfer is seen) but is a Transfer, so it is **not** added to the bills total (see A1/A4).

**Each bill has:** name · amount · how often (monthly / yearly) · due day (e.g. 1st) or due date for yearly (e.g. 15 Mar) · account it's paid from (Flex / credit card) · text to match on the statement (defaults to the name) · notes.

**Main view — the selected pay period** (‹ › to move between periods):

| Bill | Due | Amount | Status |
|---|---|---|---|
| Rent | 1 Nov | £675 | ⏳ due in 11 days |
| Phone | 29 Oct | £11.41 | ⏳ due in 8 days |
| Council Tax | 18 Oct | £61 | ✅ paid 18 Oct · £61 |
| Gym | — | £30 | 💤 not due this period |

Footer: **Total due this period · paid so far · still to pay** and the smoothed average for comparison.

**Statuses:** ✅ paid · ⏳ due in N days · 🔴 overdue · ⏭ skipped · 💤 not due this period · ✏️ = something was set by hand.
A payment that differs from the expected amount shows a note, e.g. "✅ paid £64 (£3 more than usual)".

**Automatic matching (replaces the Reconcile tab):** a payment is matched to a bill when its description contains the bill's match text and it's within a few days of the due date, on the bill's account. No manual assigning needed in the normal case.

**Tap a bill → manual overrides for that occurrence:**
- Pick a different payment / unlink a wrong match / link more than one payment.
- Mark as paid manually (cash, another account) with date + amount.
- Skip it this period.
- Change the amount **this time only** (e.g. one-off bigger energy bill).
- Change the due date **this time only** (e.g. taken on Monday because of a weekend).

**Editing a bill itself** (amount, due day, account): applies from the current period onwards; past periods keep what they were.

### 3.3 Budget tab

One table for the selected pay period (‹ › to move):

| Category | Budget | Spent | Left |
|---|---|---|---|
| Bills | £812 *(from Bills tab)* | £73 | £739 |
| Groceries | £230 | £85 | £145 ▓▓░░ |
| Pub/Social | … | … | … |

- **Top summary:** Pay £X − bills due £Y − category budgets £Z − savings target £S = **left unallocated**.
  Pay = salary received in the period; for a future period, your last pay (editable).
- **Bills row** is read-only — always the total from the Bills tab for that period.
- **One standard budget** for every period. Editing a number asks: **"This period only"** or **"This and future periods"**. Period-only changes show ✏️ with "Reset to standard".
- **Spent** = Spend rows in that category in the period, minus Refund rows in the same category (see 3.7). Transfers never count.
- **Savings target** row (not a category): planned vs. **net saved** = transfers to savings − transfers back from savings in the period.
- Payday override (3.1) is edited from the period header here.

### 3.4 Dashboard
- New default view **Pay period**; Week / Month / Year / All stay for reporting (budgets pro-rated by day for Week/Month).
- New **Until payday** card: days left · Flex balance now · Flex bills still due before payday · card balance owed · **safe to spend** (= Flex balance − card balance owed − Flex bills still due before payday) · per-day allowance. Card purchases therefore reduce safe to spend straight away, even though the card is paid off later.
- "Bills seen" card becomes **Bills this period** (same statuses as the Bills tab).
- Pace, trend, top merchants, cash flow, net worth stay — they just follow the selected pay period.

### 3.5 Ledger
- New row option **"Count in another period"** — the bank date is untouched (so balances still reconcile), only the period it's budgeted in changes. Shown with ✏️; reset available.
- Replaces today's "Reassign to a different month", which changes the real date.
- Row types, accounts and categories: see 3.7.

### 3.7 Ledger: accounts, row types and categories

**What's wrong today** (checked against the 1,039 spending + 94 money-in rows):
- Money-in "source" mixes three different things: real income (Salary £14k, Presents), people paying you back (flatmates' share of bills £2.5k, friends for drinks, shop refunds — filed under Bills, Pub/Social, Groceries…) and your own money moving between accounts (Savings £7.4k).
- Some "spending" isn't spending: **Savings** (£7.3k to Moneybox / Regular Saver) and **Credit** (card repayments) are your own money moving.
- **Other** (£4.6k) is a catch-all: clothes/shopping, health (pharmacy, Specsavers, barber), the £708 Novuna payment, the £577 Goodlord fee, cash withdrawals, card cash fee/interest.
- "Presents" (money in) and "Gifts" (money out) are different names for related things.

**Accounts**

| Account | What it is | How it's tracked |
|---|---|---|
| **Flex** | Main current account; pay comes in, bills go out | Statement import. Drives *safe to spend*. |
| **Credit card** | Spending account you pay off | Statement import. Purchases count as spending **when charged**. The repayment is a Transfer, never spending. |
| **Savings** (FTC ISA, S&S ISA, Cash ISA, Regular Saver …) | Pots | Balances typed in on the Accounts tab, as now. Money in/out shows up only as Transfers on Flex. |
| **Cash** | Notes and coins | Cash counter on the Accounts tab, as now. |

Ledger gets an account filter (All / Flex / Card) and a type filter. Money out and money in are shown in one list (money in in green).

**Row types**

| Type | Direction | Examples | Effect |
|---|---|---|---|
| **Spend** | out | Tesco, pub, rent | Counts against its category. |
| **Refund** | in | Flatmate's share of rent, friend paying you back, shop refund | Takes the amount off its category, so e.g. Bills shows only *your* share. |
| **Income** | in | Salary, birthday money | Counts as pay / income. |
| **Transfer** | out or in | Card repayment, to/from Moneybox, Regular Saver | Ignored in spending and income; only moves balances. Has a *to/from* account (Card / Savings). Transfers to/from Savings feed the savings target. |

The type is set automatically by rules (e.g. "MONEYBOX" → Transfer to Savings; Nationwide card repayment → Transfer to Card) and can be changed on any row.

**Categories**

Spending (used by Spend and Refund rows):

| New category | Replaces / takes from | Typical rows |
|---|---|---|
| Bills | Bills | Only rows linked to a bill (set by the Bills tab) |
| Groceries | Groceries | Supermarkets |
| Pub & Social | Pub/Social | Pubs, tickets, nights out |
| Eating out | Takeaway/Restaurant | Restaurants, takeaways, coffee |
| Transport | Travel/Car | Trains, fuel, parking, bike bits |
| Shopping | *from Other* | Clothes, Amazon, Argos, Decathlon, electronics |
| Health & Personal | *from Other* | Pharmacy, Specsavers, barber, NHS prescription |
| Home | *from Other* | Letting fees, B&Q, dry cleaning, household |
| Gifts | Gifts | Presents for others |
| Other | Other | Anything genuinely one-off |

Income (used by Income rows only): **Salary · Gifts received · Other income**.

Removed as categories: **Savings** (now Transfer + savings target) and **Credit** (now Transfer to Card).

### 3.6 Restart from 18 Sep (Data tab, one-off wizard)
1. **Backup** — downloads the full current document as JSON first.
2. **Preview** (nothing saved yet):
   - Opening balances at close of 17 Sep — Flex and credit card — calculated from the ledger, **editable** so you can type the bank's figure.
   - Rows kept (18 Sep onwards) vs rows archived.
   - Bills carried over from today's monthly + yearly bills with their current amounts; **you set each due day** and account; £0 bills can be ticked off.
   - Standard category budget pre-filled from September's monthly budget × 12/13 (e.g. £250/month → £231/period), editable; new categories (Shopping, Health & Personal, Home) start at £0 for you to fill in, plus a savings target.
   - **Kept rows converted to types + new categories:** Savings → Transfer (Savings); Credit → Transfer (Card); Takeaway/Restaurant → Eating out; Travel/Car → Transport; Pub/Social → Pub & Social; money in from Salary → Income/Salary; Presents/Gifts → Income/Gifts received; Savings → Transfer from Savings; Bills/Groceries/Pub/etc. → Refund in that category. **Other** rows (out and in) are listed for you to pick a category/type, with a suggestion from the rules.
   - Rules re-pointed to the new category names; new transfer rules added (Moneybox, Regular Saver, card repayment).
3. **Confirm:**
   - Whole old document saved to Supabase as a separate archive (`budget-2026-archive`).
   - Live budget rewritten: start date 18 Sep, new opening balances, rows ≥ 18 Sep, new bills + standard budget. Categories, rules, savings, cash and wealth history are kept.
   - Old monthly budgets, yearly-bill list and Reconcile assignments are dropped from the live budget (still in the archive).
4. **After restart:** statement imports ignore rows before 18 Sep (the preview says how many were skipped). Accounts tab shows "Opening balance (close 17 Sep)".

Until the restart has been run, Bills and Budget tabs show "Run the restart first"; Ledger, Import and Accounts keep working. The restart is not reversible in the app (the archive + JSON backup are the way back).

---

## 4. What gets removed
- Independent budgets for every month, "copy month", "clear month".
- Yearly bills sub-tab (yearly bills live in Bills).
- Reconcile sub-tab, "auto-assign by name", splitting one payment between monthly and yearly parts.
- "Hide zero" toggles.
- "Reassign to a different month" (replaced by "Count in another period").
- "Savings" and "Credit" as spending categories; separate money-in "source" list (replaced by types + income categories, 3.7).

## 5. What stays as it is
- Accounts tab balance check against the bank, wealth, cash, savings.
- Ledger, Import, Rules, Data export, cloud sync, mobile layout.

---

## 6. Assumptions — agreed 21 Oct 2026

| # | Assumption |
|---|-----------|
| A1 | The credit-card repayment is a **Transfer** from Flex to the card — never spending (the card purchases already were). It shows on the Bills tab as a reminder only, outside the bills total. |
| A2 | Bills paid **on the credit card** count when charged to the card. |
| A3 | Savings is **not** a spending category any more: it's a savings target on the Budget tab, measured by net transfers to savings in the period. |
| A4 | Most day-to-day spending goes on the credit card, paid off in full monthly. Safe to spend = Flex balance − **whole card balance owed** − Flex bills still due before payday. Available credit is never counted as money. |
| A5 | Matching window = 5 days either side of the due date; overdue = 2 days after the due date with no payment. |
| A6 | Standard category budget starts at September × 12/13 (you'll edit it in the wizard anyway). |
| A7 | No in-app viewer for the archive — download only. Can be added later. |
| A8 | One payment can still be linked to several bills (manual "link more than one" in 3.2), but there's no monthly/yearly split. |
| A9 | **Cash withdrawals** count as Spend (default category Other, changeable), because cash spending isn't itemised. |
| A10 | Card fees and interest (cash fee, cash interest) are Spend in Other. |
| A11 | Refunds reduce their category **in the period they arrive** (e.g. flatmate's rent share lands next period → use "Count in another period" if you want it matched to the rent). |
| A12 | Old archived rows are **not** converted — only rows from 18 Sep onwards get types and new categories. |
| A13 | Novuna (£708, card) is a one-off in Other. |

---

## 7. Build steps

Each step ends working and tested. Everything is built and tested on this branch against a **copy** of your data in local mode; the live site isn't touched until step 11.

| Step | What | How we check it |
|---|---|---|
| 0 | **Safety:** live-sync ignores archive documents. *(done)* | Editing an archive row doesn't change the open app. |
| 1 | **Pay-period engine** (`public/js/periods.js`): paydays, period for a date, overrides, bill due dates incl. short months. *(done)* | `node --test` unit tests: 18 Sep → 16 Oct → 13 Nov; 21 Oct is in 16 Oct–12 Nov; 31st → 30 Apr; payday override moves one boundary only; rent-on-1st skips 2–29 Apr 2027. |
| 2 | **Row types & accounts** (`model.js`): Spend / Refund / Income / Transfer, new categories, balance rules based on types (card repayment = Transfer to Card), conversion of old rows. *(done)* | Unit tests: converting today's data gives **identical** Flex and card balances; Savings/Credit rows become Transfers; each old category maps as in 3.6. |
| 3 | **Bills logic** (`model.js`): due occurrences per period, auto-match, statuses, per-occurrence overrides, amount changes from a period onward. *(done)* | Unit tests per status, manual link beats auto-match, skip, paid manually, one-off amount/date. |
| 4 | **Budget logic** (`model.js`): standard budget + "this period only" + "this and future", spent = Spend − Refund per category, savings target vs net transfers, "count in another period", pay − bills − budgets − savings summary, safe to spend. | Unit tests incl. a refund, a transfer (ignored) and a transaction moved to another period. |
| 5 | **Restart logic** (`model.js`): old document → preview, new live document (with row conversion), archive. | Unit test on a copy of real data: kept/archived counts, openings at close 17 Sep match the Accounts tab today, nothing ≥ 18 Sep lost, no kept row left without a type. |
| 6 | **Restart wizard UI** + review of Other rows + save archive to Supabase + "run restart first" gating + import ignores pre-18 Sep rows. | Run wizard locally on exported data; archive row created; import of an old statement skips old rows. |
| 7 | **Bills tab UI** incl. tap-to-override sheet. | Manual walkthrough on desktop + phone width. |
| 8 | **Budget tab UI** incl. payday override, savings target and period-only/future edits. | Manual walkthrough on desktop + phone width. |
| 9 | **Dashboard, Ledger, Import, Rules**: Pay period view, Until payday card, Bills this period; one combined ledger with account + type filters, type picker, "Count in another period"; import and rules set type + category; remove old month-budget code. | Every dashboard view renders with no console errors; numbers agree with Budget tab; importing a statement sets Moneybox rows to Transfer. |
| 10 | **Tools & docs:** Python reconcile uses types and starts at the budget's start date; README updated; unit tests run in GitHub Actions before deploy. | `reconcile.py` on restarted data shows no differences from 18 Sep; workflow passes. |
| 11 | **Go live (together):** see section 8. | Below. |

## 8. Go-live checklist
1. Data → Export a fresh backup from the live site.
2. Merge this branch → site deploys.
3. Run the restart wizard: check opening balances against the bank at 17 Sep, set bill due days and accounts, check the standard budget and savings target, sort the Other rows.
4. Import Flex + card statements from 18 Sep to today (anything already there is de-duplicated as now).
5. Check Bills tab statuses for 18 Sep–15 Oct and the current period; fix any with a manual override.
6. Accounts tab balances match the bank today; run `reconcile.py` for 18 Sep onwards.
7. Open on your phone and confirm the same numbers.

## 9. Risks
- **The restart rewrites the live document.** Mitigated by JSON backup + Supabase archive + daily version history.
- **An old open tab** (another device) could save the old shape after the restart → the existing conflict prompt appears; choose "use cloud copy".
- **Wrong opening balance** throws every later balance off → the wizard shows the computed figure next to an editable box; check it against the 17 Sep statement.
