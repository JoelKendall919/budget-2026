# Budget 2026 — app

A small budgeting app that runs in your browser. Everything stays on your computer.

## Opening it

Double-click **`Budget App.cmd`**. It opens the app in your browser and leaves a
small server window running (close that window when you're done).

The very first time, click **"Link budget-data.json"** and pick the
`budget-data.json` file in this folder. From then on every change you make
(categorising, budgets, imports) saves straight back to that file automatically —
you never have to press save.

*(You can also just double-click `budget-app.html`, but then changes are only kept
inside the browser. Linking the file is better — use the .cmd.)*

## The tabs

- **Dashboard** — pick Week / Month / Year / All at the top. Budget vs actual per
  category, spending pace, a projected month-end, the bills checklist, and a trend
  chart. Click any category row to drill into it in the Ledger.
- **Ledger** — the one register: every line in and out on a single page, date-ordered.
  This is where you edit everything.
  - Each row's **category** (spending) / **source** (income) and its **account**
    (Debit = Flex, or Credit card) are editable dropdowns.
  - **Split a category/source**: click **split** next to the dropdown to allocate one
    row across several categories (spend) or sources (income) — e.g. one £50 charge
    covering both Groceries and Household. Mirrors the bill-split feature. A saved
    split shows as a summary with **edit split**; **Remove split** collapses it back.
  - Two accounts, one page. The **account filter** (All / Flex / Credit card) doubles
    as a per-account view: pick Flex or Credit and you get that account's rows plus its
    own **running balance** (like that account's statement). "All" shows everything with
    no balance column.
  - New rows (from an import) arrive marked **"to review"** and highlighted. Check them
    and press **Confirm** to lock in (🔒; **✎** unlocks later). A badge shows how many
    need review; **"Confirm all shown"** does a filtered batch.
  - Setting a category on a new merchant offers to remember it as a rule.
  - Also filter by **category/source**, **review status**, **period**, or search; sort
    newest/oldest. **+ Spending** / **+ Income** add by hand. ✕ deletes.
  - **📅 reassigns a row to a different month** — pick any month (12 either side of its
    current one) and, optionally, a different day within it. Only the date changes;
    category, account, everything else stays put. Useful when a transaction posted a day
    or two into the next/previous month but you want it counted where it actually belongs.

Your data comes from **CSVs only** — the app reads/writes `budget-data.json` and
imports bank statement CSVs. It never opens the Excel files; those are just backups.
- **Budget** — one tab, three sub-tabs. Every month's numbers are completely
  independent — nothing here inherits from a "default" or from any other month.
  - **Monthly** — pick a month at the top. Two separate tables: **category budgets**
    and the **monthly bills budget**, both just for that month. Change March's Rent
    budget and nothing else moves — April, or any other month, keeps whatever it already
    had. A month with nothing set yet offers **"Copy from [previous month]"** (a one-time
    copy, not a link — edit afterwards without affecting where it came from) or **"Start
    from zero"**. A **"Copy to another month"** button lets you push this month's numbers
    forward (e.g. after a rent rise) without waiting to set up each month by hand. Bill
    *types* (name/notes) are a shared list below — rename or remove one and it updates
    everywhere, but each month's *amount* for that bill stays independent.
  - **Yearly bills** — entirely separate from the monthly numbers: one figure per bill
    for the whole year (BR, Google Drive, Water…), not tied to any month.
  - **Reconcile** — pick a month; its bills are reconciled against **that month's own**
    monthly-bills budget (so if you set March's Rent to £700, March expects £700 — no
    other month is affected). Columns: Expected · Paid · **In** · **Net** · Status, with
    a mini-ledger to assign each of that month's payments to a bill. Below it, the yearly
    bills reconcile the same way against the whole year's payments, using the separate
    yearly budget.
    - **Refunds & reimbursements net off** — bill income (a refund, or a friend's share)
      shows in **In** and reduces **Net** (e.g. the £283.76 Council Tax refund).
    - **Split** a payment across several bills, or **part-pay** by assigning several
      payments to one bill; anything not fully allocated shows under **⚠ Unassigned**.
    - **"Auto-assign by name"** matches the obvious payments and income to bills.
- **Import** — drop a downloaded `Statement Download …csv` in. **Set the Card** at the
  top to match the statement (Debit for FlexGraduate, Credit for the Member Credit
  Card). It skips transfers, ignores anything already logged (a few days' settlement
  wobble is fine), auto-categorises with your rules, and flags anything new in red.
- **Rules** — the merchant → category list that powers auto-categorising. Shows how
  many transactions each rule matches. Edit, add, delete.
- **Accounts** — both accounts (FlexGraduate and Member Credit Card), each with its
  computed balance and a reconcile box: type that statement's balance and it tells you
  if it ties out. Savings/investments too.
- **Data** — link/export the data file. Export a backup any time.

## Weekly routine

1. Download **both** statement CSVs (FlexGraduate debit, Member Credit Card).
2. Open the app → **Import** → set **Card = Debit** → drop the Flex CSV → Confirm.
   Then **Import** again → set **Card = Credit** → drop the credit-card CSV → Confirm.
   (Rows you've already logged are skipped — nothing duplicates or gets overwritten.)
3. **Ledger** → it opens filtered to the new "to review" rows → check each
   category/source and account → **Confirm** (or "Confirm all shown").
4. **Accounts** → type each statement's balance → check both reconcile.

That's it. The old spreadsheet (`Budget 2026 v2.xlsx`) still works and is untouched;
this app and it are just two views. `budget-data.json` is the app's data — keep it
in this folder (it's in OneDrive, so it's backed up).
