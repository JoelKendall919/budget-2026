# Budget 2026

A personal budgeting app. It runs in the browser, syncs through Supabase so
your phone and your PC show the same numbers, and reconciles against real
bank statements.

Originally a single 141 KB `budget-app.html` that saved to a local JSON file.
That file is still here, in `legacy/`, for reference.

---

## Layout

```
public/                 the app — this folder is what gets deployed
  index.html
  css/styles.css        desktop design
  css/mobile.css        phone + tablet layer
  js/config.js          Supabase URL / anon key
  js/storage.js         where the data lives (cloud, local, offline queue)
  js/periods.js         pay-period dates
  js/model.js           rows, balances, bills, budgets and the restart
  js/app.js             the screens: dashboard, ledger, bills, budget, import…
  sw.js                 offline app shell
supabase/schema.sql     run this once in your Supabase project
tests/                  unit tests for periods.js, model.js and storage.js
tools/                  reconciliation scripts (Python)
local/                  YOUR DATA — gitignored, never leaves this machine
legacy/                 the original single-file app
docs/                   the original README; plans/ has the pay-period plan
```

`periods.js` and `model.js` are pure functions — no screen, no storage — so
every rule in them is unit-tested. `app.js` only draws them.

**`local/` is gitignored and must stay that way.** It holds
`budget-data.json`, bank statement CSVs, the credit-card PDFs and the old
spreadsheets. None of that belongs in a Git repository.

---

## How the budget works

You're paid every four weeks, so the budget runs in **pay periods**: from a
payday to the day before the next one, 28 days, starting with payday on
18 Sep 2026. Most bills are still monthly, so a period holds whichever bill
dates fall inside it — usually one of each, now and then two.

| Tab | What it's for |
|---|---|
| **Dashboard** | this period at a glance: budget against actual, bills, your pace |
| **Ledger** | every row; ones no rule recognised are flagged *to review* |
| **Bills** | the bills due this period, each matched to its payment |
| **Budget** | what you plan to spend per category this period, against what you have |
| **Import** | add a bank CSV |
| **Rules** | which bank description means which category, or which transfer |
| **Accounts** | balances (savings typed in by hand) and the reconcile check |

**Bills.** Each bill is monthly (a due day) or yearly (a date), paid from
Flex or the card, with *match text* — words from its bank description. A
matching payment near the due date is linked to it automatically. Leave the
match text blank for bills paid with a description they share — e.g. money
sent to your own "Joel Kendall" account — and link those by hand: tap the
bill → *Link a payment…* (one payment can cover several bills). Tap a bill
to link a different payment, mark it paid by hand, skip it this period, or
change its amount or due date this time only.

**Budget.** A standard amount per category, plus what goes into savings,
applies to every period. Change it for **this period only** (a month with a
holiday) or for **this and future periods**. Paid early or late? **Change
payday** moves that period's dates.

**Every row has a type:**

| Type | Is | Counts as |
|---|---|---|
| Spend | money out on a category | spending |
| Refund | money back for a category | takes spending off that category |
| Income | Salary, Gifts received, Other income | income |
| Transfer | your own money moving between Flex, the card and Savings | neither |

Paying the card off is a transfer from Flex to the card. The purchases on the
card were the spending, so the repayment isn't. Cash withdrawals are spending.

**Rules.** The longest matching text wins. An income rule (Salary, Gifts
received, Other income) only applies to money in, and there it beats a
spending rule — so "sainsbury" is Salary for pay coming in and Groceries for
shopping going out.

**The restart.** Data → Pay periods → *Restart from payday…* is a one-off
wizard. It sets the opening balances at the close of 17 Sep, adds Salary
rules for "midsummer energy" and "sainsbury", drafts your bills (shared
descriptions left blank to link by hand) and a budget from past spending, asks about any rows it can't classify,
keeps the rows from payday on and moves everything earlier to an archive copy
(in the cloud when you're signed in). Until then Bills and Budget ask you to
run it.

---

## Running it locally

```bash
python3 -m http.server 8777 --bind 127.0.0.1 --directory public
# then open http://localhost:8777
```

Or in VS Code: **Run → Open Budget app in Chrome**, or the
*Serve app* task (`⇧⌘P → Tasks: Run Task`).

You need a real HTTP server rather than opening the file directly —
service workers and the Supabase client both refuse to run on `file://`.

### Tests

```bash
node --test tests/*.test.js
```

Node's built-in test runner, nothing to install. A few tests in
`model.test.js` and `restart.test.js` also run against your real data in
`local/budget-data.json` (or the file `BUDGET_DATA` points at); without it
they're skipped, as they are on GitHub, where the tests run before every
deploy.

---

## Setting up cloud sync

You get sync across devices for free on Supabase's free tier.

1. **Create a project** at <https://supabase.com>.

2. **Create the table.** Dashboard → SQL Editor → paste all of
   `supabase/schema.sql` → Run. This creates the table, locks it down with
   row-level security, turns on realtime, and sets up daily version
   snapshots.

3. **Create your login.** Dashboard → Authentication → Users → Add user →
   *Create new user*. Give it your email and a password, and tick **Auto
   Confirm User** so you don't have to click a confirmation email.

   Then close the door behind you: Authentication → **Sign In / Providers**
   → *Supabase Auth* tab → **User Signups** → turn off **Allow new users to
   sign up** → Save changes.

   This matters because `config.js` is committed, so anyone reading this
   repo has the project URL and publishable key. They still can't touch
   your data — row-level security sees to that — but without this they
   could create accounts on your project and eat your free-tier quota.

   To check it worked:

   ```bash
   curl -s -X POST "https://YOURPROJECT.supabase.co/auth/v1/signup" \
     -H "apikey: sb_publishable_…" -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"Str0ngPassw0rd!x"}'
   # expect: {"code":422,"msg":"Signups not allowed for this instance"}
   ```

4. **Point the app at the project.** Dashboard → Project Settings → API
   Keys → **Publishable and secret API keys**. Copy the *Project URL* and
   the **publishable** key (`sb_publishable_…`) into `public/js/config.js`:

   ```js
   supabaseUrl: "https://yourproject.supabase.co",
   supabaseAnonKey: "sb_publishable_…",
   ```

   The publishable key is *designed* to be public — it's in every browser
   that loads the page. Row-level security is what actually protects the
   data, so don't skip step 2. **Never use the secret key
   (`sb_secret_…`) here**: it bypasses RLS entirely. The app refuses to
   start if it finds one, and the deploy workflow refuses to publish.

   Older projects have JWT-style `anon` / `service_role` keys instead,
   under the *Legacy API keys* tab. Those still work.

   These two values are committed to this repo, which is fine — the
   publishable key grants nothing on its own. If you'd rather keep them
   out, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as GitHub Actions
   secrets and the deploy workflow will override whatever is in the file.

5. **Load your existing data.** Sign in, then Data → *Import JSON…* and pick
   `local/budget-data.json`. It uploads on the next save. After that every
   device that signs in gets the same document.

### Deploying to GitHub Pages

1. Push to GitHub.
2. Settings → Secrets and variables → Actions → add `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`.
3. Settings → Pages → Source: **GitHub Actions**.

`.github/workflows/deploy.yml` substitutes the secrets into `config.js` at
build time, refuses to deploy if it finds a `service_role` key or a
`budget-data.json` in `public/`, and publishes the folder.

On your phone, open the Pages URL and *Add to Home Screen* — it installs as
a standalone app.

### How syncing behaves

The whole budget is one JSON document in one row, with a `revision` counter.

- Edits save to this device immediately, then push to Supabase after a
  short pause.
- Offline, changes queue and go up when you're back.
- If another device saved while you were offline, the write is **rejected
  rather than overwriting it**, and you're asked which version to keep.
- Edits made elsewhere arrive live, or within 30 seconds.

---

## Reconciling against your bank

`tools/` reads the statements in `local/statements/` and compares them to
the app, to the penny.

```bash
pip install -r tools/requirements.txt      # once (pdfplumber, for the PDFs)

python3 tools/reconcile.py                 # check everything
python3 tools/apply_fixes.py               # show what it would change
python3 tools/apply_fixes.py --write       # apply it (takes a backup first)
```

Put statements here:

| What | Where |
|---|---|
| FlexGraduate (debit) CSV | `local/statements/` |
| Member Credit Card CSVs | `local/statements/credit-statements/` |
| Credit card PDF statements | `local/statements/credit-card-pdfs/` |

Once the budget has been restarted, both scripts check from its start date
(18 Sep 2026): anything earlier on a statement belongs to the archive and is
ignored. `--from YYYY-MM-DD` can move the start later, never earlier.

### Why it can be this precise

The debit CSV has a **running balance** column, so `reconcile.py` walks it
day by day and names the exact date the app stopped agreeing — rather than
just reporting one unhelpful total at the end.

The credit card has no running balance, so the period CSV exports are merged
into a single ledger instead. They overlap, so merging takes the *highest*
count any one export gives for a given transaction, never the sum: that
collapses the overlap without destroying genuine same-day duplicates.

### Two date conventions

The credit-card **PDFs** date a transaction when it *settles*. The **CSV
exports** and the app date it when you *spent*. They disagree by a few days
around a statement boundary, which is normal and not an error. Trust the
CSVs for rows and the PDFs for closing balances — which is exactly what the
tool does.

### `apply_fixes.py` and what it does with a mismatch

It won't blindly delete. Each difference is classified first:

- **date shift** — same merchant and amount on both sides a few days apart.
  Real transaction, wrong day: it's moved, keeping its id and category.
- **duplicate** — the app has a row the bank has no counterpart for at all.
  Imported twice: deleted.
- **missing** — on the statement, not in the app. Added with a type and
  category from your rules, exactly as Import would add it, and flagged for
  review if no rule matched.

It then checks the result would tie exactly and **refuses to write if it
wouldn't**. A timestamped backup is taken before any change.

---

## How the numbers work

Worth knowing before changing any of the balance code, because the sign
conventions are not obvious.

Every `amount` is stored **positive**. `transactions` is money out and
`income` is money in; `card: "Credit"` puts a row on the credit card,
anything else is on Flex. A row moves its own account, and a transfer
between Flex and the card moves **both**:

| Row | Flex | Card debt |
|---|---|---|
| Spend on Flex | down | — |
| Spend on the card (`card: "Credit"`) | — | up |
| Refund or income onto Flex | up | — |
| Refund onto the card | — | down |
| Paying the card off: a Flex row, `type: "Transfer"`, `to: "Card"` | down | down |
| Transfer to savings (`to: "Savings"`) / from savings (`from: "Savings"`) | down / up | — |

So:

```
flex   = openingFlex   + money in on Flex − money out of Flex
credit = openingCredit + money in on the card − card spending + payments from Flex
```

`credit` is negative while you owe money on the card. Savings balances are
typed in on the Accounts tab, so a transfer to or from savings only moves
Flex. After the restart, the opening balances are the ones at the close of
the day before its start date.

Rows saved before types existed have no `type` and are read the way the app
always read them: money out in `"Savings"` is a transfer to savings, and
money out in a category that isn't in `categories` (in practice `"Credit"`)
is a card repayment. The restart converts the rows it keeps by the same
rules, so no balance moves unless you change what a row is in the wizard.

The rules are `classify` and `effects` in `public/js/model.js`;
`tools/budget_lib.py` mirrors them. **If you change one, change the
other**, or the tools will quietly start disagreeing with the app.

---

## The weekly routine

1. Download the FlexGraduate CSV and the credit-card CSV.
2. App → **Import** → set **Card** to match → drop the file → Confirm.
   Already-logged rows are skipped. Transfers to and from savings on Flex
   come in as Transfer rows (unless a rule says otherwise, e.g. "joel kendall"
   → Bills); the card's "payment received" rows don't, as the Flex side
   already has the repayment.
3. **Ledger** → check the rows flagged *to review*: give each a type and
   category. The app offers to make a rule, so next time it's automatic.
4. **Bills** → check each bill has found its payment.
5. Drop the CSVs into `local/statements/` and run
   `python3 tools/reconcile.py`.

Step 5 is the one that catches double-imports early, while you can still
remember what the transaction was.
