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
  js/app.js             everything else: views, budgets, import, ledger
  sw.js                 offline app shell
supabase/schema.sql     run this once in your Supabase project
tools/                  reconciliation scripts (Python)
local/                  YOUR DATA — gitignored, never leaves this machine
legacy/                 the original single-file app
docs/                   the original README, kept for the feature notes
```

**`local/` is gitignored and must stay that way.** It holds
`budget-data.json`, bank statement CSVs, the credit-card PDFs and the old
spreadsheets. None of that belongs in a Git repository.

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

---

## Setting up cloud sync

You get sync across devices for free on Supabase's free tier.

1. **Create a project** at <https://supabase.com>.

2. **Create the table.** Dashboard → SQL Editor → paste all of
   `supabase/schema.sql` → Run. This creates the table, locks it down with
   row-level security, turns on realtime, and sets up daily version
   snapshots.

3. **Create your login.** Dashboard → Authentication → Users → Add user.
   Give it your email and a password. (Or use *Email me a link* in the app
   and confirm from your inbox.)

4. **Point the app at the project.** Dashboard → Project Settings → API
   Keys → **Publishable and secret API keys**. Copy the *Project URL* and
   the **publishable** key (`sb_publishable_…`) into `public/js/config.js`:

   ```js
   supabaseUrl: "https://yourproject.supabase.co",
   supabaseAnonKey: "<your anon public key>",
   ```

   The publishable key is *designed* to be public — it's in every browser
   that loads the page. Row-level security is what actually protects the
   data, so don't skip step 2. **Never use the secret key
   (`sb_secret_…`) here**: it bypasses RLS entirely. The app refuses to
   start if it finds one, and the deploy workflow refuses to publish.

   Older projects have JWT-style `anon` / `service_role` keys instead,
   under the *Legacy API keys* tab. Those still work.

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
- **missing** — on the statement, not in the app. Added, categorised by your
  rules, flagged for review.

It then checks the result would tie exactly and **refuses to write if it
wouldn't**. A timestamped backup is taken before any change.

---

## How the numbers work

Worth knowing before changing any of the balance code, because the sign
conventions are not obvious.

Every `amount` is stored **positive**. Direction comes from which list the
row is in and from its `card` field:

| Row | Effect |
|---|---|
| `transactions`, `card: "Debit"`, real category | Flex down — ordinary spending |
| `transactions`, `card: "Debit"`, category `"Credit"` | Flex down **and** card debt down — this is a card repayment |
| `transactions`, `card: "Credit"` | Card debt up — a purchase on the card |
| `income`, `card: "Credit"` | Card debt down — a refund onto the card |
| `income`, anything else | Flex up |

So:

```
flex   = openingFlex   − debitSpend + flexIncome − cardRepayments
credit = openingCredit − cardCharges + cardRepayments + cardRefunds
```

A card repayment is one row that moves both accounts. That's why it must
never be counted as spending, and why its category is deliberately not in
`categories`.

`tools/budget_lib.py` mirrors these rules. **If you change one, change the
other**, or the tools will quietly start disagreeing with the app.

---

## The weekly routine

1. Download the FlexGraduate CSV and the credit-card CSV.
2. App → **Import** → set **Card** to match → drop the file → Confirm.
   Already-logged rows are skipped.
3. **Ledger** → check the new "to review" rows → **Confirm**.
4. Drop the CSVs into `local/statements/` and run
   `python3 tools/reconcile.py`.

Step 4 is the one that catches double-imports early, while you can still
remember what the transaction was.
