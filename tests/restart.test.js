"use strict";
// Run with: node --test tests/
// The real-data checks read a COPY of the budget document, never the live one:
//   BUDGET_DATA=/path/to/copy.json node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../public/js/model.js");
const P = require("../public/js/periods.js");

const OLD_CATS = ["Bills", "Groceries", "Pub/Social", "Takeaway/Restaurant", "Travel/Car", "Gifts", "Other", "Savings"];
const START = "2026-09-18", CLOSE = "2026-09-17", TODAY = "2026-10-21";
const tx = (id, date, name, amount, card, category, extra = {}) => ({ id, date, name, amount, card, category, ...extra });
const inc = (id, date, name, amount, card, source, extra = {}) => ({ id, date, name, amount, card, source, ...extra });

// A budget in the shape it has before the restart.
function oldDoc() {
  return {
    meta: { currency: "GBP", generated: "2026-09-17", source: "test" },
    categories: OLD_CATS.slice(),
    bills: [{ name: "Rent", notes: "" }, { name: "Phone", notes: "" }, { name: "Claude", notes: "" }, { name: "Bike", notes: "Novuna Finance" }],
    yearlyBills: [{ name: "BR", amount: 75, notes: "" }, { name: "Water", amount: 180, notes: "Est." }],
    monthlyBudgets: {
      "2026-08": { categories: { Groceries: 300 }, bills: { Rent: 1000, Phone: 10, Claude: 18, Bike: 197.63 } },
      "2026-09": {
        categories: { Bills: 1277.04, Groceries: 250, "Pub/Social": 200, "Takeaway/Restaurant": 20, "Travel/Car": 50, Gifts: 0, Other: 100, Savings: 65 },
        bills: { Rent: 1050, Phone: 11.41, Claude: 18, Bike: 197.63 },
      },
      "2026-10": { categories: { Groceries: 999 }, bills: { Rent: 1050, Phone: 11.41, Claude: 0, Bike: 197.63 } },
      "2026-11": { categories: {}, bills: { Rent: 2000 } },
    },
    rules: [
      { match: "moneybox", category: "Savings" }, { match: "Regular Saver", category: "Savings" },
      { match: "gymshark", category: "Gifts" }, { match: "tesco", category: "Groceries" },
      { match: "uber eats", category: "Takeaway/Restaurant" }, { match: "amazon", category: "Other" },
      { match: "member credit card", category: "Other" },
    ],
    accounts: { openingFlex: 1000, openingCredit: 0, savings: [{ name: "ISA", balance: 500 }], cash: { n20: 1 } },
    wealthSnapshots: [{ date: "2026-08-01", total: 1500 }],
    transactions: [
      tx("a1", "2026-08-28", "JOEL  KENDALL", 1050, "Debit", "Bills", { bill: "Rent" }),
      tx("a2", "2026-08-29", "Vodafone Ltd", 11.41, "Debit", "Bills", { bill: "Phone" }),
      tx("a3", "2026-09-01", "tesco", 40, "Credit", "Groceries"),
      tx("a4", "2026-09-10", "MEMBER CREDIT CARD", 40, "Debit", "Credit"),
      tx("a5", "2026-09-17", "moneybox", 50, "Debit", "Savings"),
      tx("a6", "2026-08-06", "novuna personal fi", 197.63, "Debit", "Bills", { billSplits: [{ bill: "Bike", amount: 197.63 }] }),
      tx("a7", "2026-08-15", "anthropic", 18, "Credit", "Bills", { bill: "Claude" }),
      tx("k1", "2026-09-18", "tesco", 30, "Credit", "Groceries", { flagged: true }),
      tx("k2", "2026-09-20", "amazon", 25, "Credit", "Other"),
      tx("k3", "2026-09-25", "uber eats", 15, "Credit", "Takeaway/Restaurant"),
      tx("k4", "2026-09-28", "joel kendall", 1050, "Debit", "Bills", { bill: "Rent" }),
      tx("k5", "2026-10-05", "member credit card", 60, "Debit", "Credit"),
      tx("k6", "2026-10-06", "moneybox", 50, "Debit", "Savings"),
      tx("k7", "2026-10-08", "cash withdrawal", 20, "Debit", "Other"),
    ],
    income: [
      inc("ai1", "2026-08-21", "ACME PAYROLL", 2000, "Debit", "Salary"),
      inc("ki1", "2026-09-18", "ACME PAYROLL", 2100, "Debit", "Salary"),
      inc("ki2", "2026-09-22", "tesco refund", 5, "Credit", "Groceries"),
      inc("ki3", "2026-09-30", "flatmate", 400, "Debit", "Other", { bill: "Rent" }),
      inc("ki4", "2026-10-01", "moneybox", 100, "Debit", "Savings"),
      inc("ki5", "2026-10-02", "mum", 50, "Debit", "Presents"),
      inc("ki6", "2026-10-03", "uber eats refund", 7, "Credit", "Other"),
    ],
  };
}

// The wizard's choices: the preview as it comes, with due dates filled in
// and three of the review rows decided.
const DUE = { rent: 28, phone: 28, claude: 15, bike: 6, "credit-card-repayment": 5, br: "03-01", water: "10-01" };
function choicesFor(pv) {
  return {
    start: pv.start, openings: pv.openings, budget: pv.budget,
    bills: pv.bills.map(b => ({ ...b, dueDay: b.freq === "monthly" ? DUE[b.id] : null, dueDate: b.freq === "yearly" ? DUE[b.id] : null })),
    review: {
      "out:k7": { type: "Spend", category: "Other" },
      "in:ki3": { type: "Refund", category: "Bills" },
      "in:ki6": { type: "Refund", category: "Eating out" },
    },
  };
}

/* ---------------- preview ---------------- */
test("preview: opening balances are the balances at the close of the day before the start", () => {
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  assert.equal(pv.start, START);
  assert.equal(pv.close, CLOSE);
  // Flex 1000 − 1050 − 11.41 − 40 (card repayment) − 50 (savings) − 197.63 + 2000;
  // card −40 + 40 − 18
  assert.deepEqual(pv.openings, { flex: 1650.96, card: -18 });
});

test("preview: counts the rows kept (from the start) and archived (before it)", () => {
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  assert.deepEqual(pv.counts, { kept: { out: 7, in: 6 }, archived: { out: 7, in: 1 } });
});

test("preview: draft bills — this month's amounts, yearly bills, the card reminder; £0 bills unticked", () => {
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  const base = { dueDay: null, dueDate: null, reminder: false };
  assert.deepEqual(pv.bills, [
    { ...base, id: "rent", name: "Rent", notes: "", match: "joel kendall", freq: "monthly", amount: 1050, account: "Flex", include: true },
    { ...base, id: "phone", name: "Phone", notes: "", match: "vodafone ltd", freq: "monthly", amount: 11.41, account: "Flex", include: true },
    { ...base, id: "claude", name: "Claude", notes: "", match: "anthropic", freq: "monthly", amount: 0, account: "Card", include: false },
    { ...base, id: "bike", name: "Bike", notes: "Novuna Finance", match: "novuna personal fi", freq: "monthly", amount: 197.63, account: "Flex", include: true },
    { ...base, id: "br", name: "BR", notes: "", match: "", freq: "yearly", amount: 75, account: "Flex", include: true },
    { ...base, id: "water", name: "Water", notes: "Est.", match: "", freq: "yearly", amount: 180, account: "Flex", include: true },
    { ...base, id: "credit-card-repayment", name: "Credit card repayment", notes: "Reminder only: a transfer, not counted in bills",
      match: "member credit card", freq: "monthly", amount: 0, account: "Flex", reminder: true, include: true },
  ]);
});

test("preview: bill amounts come from the latest month up to today, never a later one", () => {
  const amounts = today => Object.fromEntries(M.restartPreview(oldDoc(), START, today).bills.map(b => [b.id, b.amount]));
  assert.equal(amounts("2026-09-20").claude, 18, "September");
  assert.equal(amounts("2026-12-01").rent, 2000, "November is the latest month");
  assert.equal(amounts("2026-07-01").rent, 1000, "before every month: the first one");
  assert.equal(M.restartPreview(oldDoc(), START, "2026-09-20").bills.find(b => b.id === "claude").include, true);
});

test("preview: a bill's match text and account are the ones seen most often, the latest on a tie", () => {
  const old = {
    categories: OLD_CATS, monthlyBudgets: {}, income: [],
    bills: [{ name: "Water - Monthly" }], yearlyBills: [{ name: "Water", amount: 180 }],
    transactions: [
      tx("w1", "2026-03-01", "www.south-staffs-water", 90, "Credit", "Bills", { bill: "Water" }),
      tx("w2", "2026-06-01", "joel kendall", 500, "Debit", "Bills", { billSplits: [{ bill: "Rent", amount: 410 }, { bill: "Water", amount: 90 }] }),
    ],
  };
  const [monthly, yearly] = M.restartPreview(old, START, TODAY).bills;
  assert.deepEqual([monthly.id, monthly.match, monthly.account, monthly.include], ["water-monthly", "", "Flex", false]);
  assert.deepEqual([yearly.id, yearly.match, yearly.account], ["water", "joel kendall", "Flex"]);
});

test("bill ids are slugs of the name, numbered when taken", () => {
  assert.equal(M.newBillId("Gas/Elec", []), "gas-elec");
  assert.equal(M.newBillId("Rent", [{ id: "rent" }]), "rent-2");
  assert.equal(M.newBillId("Rent", [{ id: "rent" }, { id: "rent-2" }]), "rent-3");
  assert.equal(M.newBillId("£££", []), "bill");
});

test("preview: standard budget = September × 12/13 to the pound, new names, Savings → savings target", () => {
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  assert.deepEqual(pv.budget, {
    cats: { Groceries: 231, "Pub & Social": 185, "Eating out": 18, Transport: 46, Shopping: 0, "Health & Personal": 0, Home: 0, Gifts: 0, Other: 92 },
    savings: 60,
  });
});

test("rules: renamed, Savings → transfer, card repayment rule added (it wins over an old one)", () => {
  assert.deepEqual(M.restartPreview(oldDoc(), START, TODAY).rules, [
    { match: "member credit card", transfer: "Card" },
    { match: "regular saver", transfer: "Savings" },
    { match: "uber eats", category: "Eating out" },
    { match: "moneybox", transfer: "Savings" },
    { match: "gymshark", category: "Gifts" },
    { match: "amazon", category: "Other" },
    { match: "tesco", category: "Groceries" },
  ]);
  const r = M.restartRules([
    { match: "acme payroll", category: "Salary" }, { match: "nan", category: "Presents" },
    { match: "pay off", category: "Credit" }, { match: "odd", category: "Holiday" }, { match: "x", transfer: "Flex" },
  ]);
  const by = Object.fromEntries(r.map(x => [x.match, x.transfer ? "→" + x.transfer : x.category]));
  assert.deepEqual(by, { "member credit card": "→Card", "acme payroll": "Salary", nan: "Gifts received", "pay off": "→Card", odd: "Other", x: "→Flex" });
});

test("preview: Other rows are listed for review with what they'd become and the rule's suggestion", () => {
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  assert.deepEqual(pv.review.map(r => ({ key: r.dir + ":" + r.id, now: r.now, suggestion: r.suggestion })), [
    { key: "out:k2", now: { type: "Spend", category: "Other", other: null }, suggestion: { type: "Spend", category: "Other", other: null } },
    { key: "out:k7", now: { type: "Spend", category: "Other", other: null }, suggestion: null },
    { key: "in:ki3", now: { type: "Refund", category: "Other", other: null }, suggestion: null },
    { key: "in:ki6", now: { type: "Refund", category: "Other", other: null }, suggestion: { type: "Refund", category: "Eating out", other: null } },
  ]);
  assert.equal(pv.review[0].row.name, "amazon", "the row itself, for showing");
});

/* ---------------- problems ---------------- */
test("problems: missing openings, and every ticked bill without a due day or date", () => {
  assert.deepEqual(M.restartProblems({}), ["Opening Flex balance needs a number.", "Opening card balance needs a number."]);
  const pv = M.restartPreview(oldDoc(), START, TODAY);
  const probs = M.restartProblems({ openings: pv.openings, bills: pv.bills });
  assert.deepEqual(probs, [
    "Rent: set the due day (1–31).", "Phone: set the due day (1–31).", "Bike: set the due day (1–31).",
    "BR: set the due date (day and month).", "Water: set the due date (day and month).",
    "Credit card repayment: set the due day (1–31).",
  ]);
  assert.deepEqual(M.restartProblems(choicesFor(pv)), []);
});

test("problems: due days, due dates, amounts, accounts and names are checked", () => {
  const ok = { id: "x", name: "X", amount: 10, freq: "monthly", dueDay: 1, account: "Flex", include: true };
  const probs = (bill, extra = {}) => M.restartProblems({ openings: { flex: 0, card: -5 }, bills: [{ ...ok, ...bill }], ...extra });
  assert.deepEqual(probs({}), []);
  for (const dueDay of [0, 32, 1.5, "abc", "", null]) assert.equal(probs({ dueDay }).length, 1, "dueDay " + dueDay);
  for (const dueDay of ["15", 31]) assert.deepEqual(probs({ dueDay }), [], "dueDay " + dueDay);
  for (const dueDate of ["02-30", "13-01", "3-1", "", null]) assert.equal(probs({ freq: "yearly", dueDate }).length, 1, "dueDate " + dueDate);
  for (const dueDate of ["02-29", "12-31"]) assert.deepEqual(probs({ freq: "yearly", dueDate }), [], "dueDate " + dueDate);
  assert.deepEqual(probs({ account: "Savings" }), ["X: paid from Flex or the card?"]);
  assert.deepEqual(probs({ amount: "" }), ["X: amount needs a number."]);
  assert.deepEqual(probs({ amount: -5 }), ["X: amount needs a number."]);
  assert.deepEqual(probs({ amount: "12.50" }), []);
  assert.deepEqual(probs({ name: "  " }), ["A bill has no name."]);
  assert.deepEqual(probs({ freq: "weekly" }), ["X: monthly or yearly?"]);
  assert.deepEqual(probs({ include: false, dueDay: null, amount: "" }), [], "unticked bills aren't checked");
  assert.deepEqual(M.restartProblems({ openings: { flex: "-5", card: "0" }, bills: [ok, ok] }), ["X: two bills have the same id."]);
  assert.deepEqual(M.restartProblems({ openings: { flex: "abc", card: 0 } }), ["Opening Flex balance needs a number."]);
});

test("problems: a review decision must have a type and a category that fit the row", () => {
  const probs = review => M.restartProblems({ openings: { flex: 0, card: 0 }, review });
  const bad = ["A reviewed row needs a type and category that fit it."];
  assert.deepEqual(probs({ "in:x": { type: "Income", category: "Salary" } }), []);
  assert.deepEqual(probs({ "in:x": { type: "Refund", category: "Groceries" } }), []);
  assert.deepEqual(probs({ "out:x": { type: "Spend", category: "Groceries" } }), []);
  assert.deepEqual(probs({ "out:x": { type: "Transfer", other: "Savings" } }), []);
  assert.deepEqual(probs({ "in:x": { type: "Income", category: "Groceries" } }), bad);
  assert.deepEqual(probs({ "out:x": { type: "Refund", category: "Groceries" } }), bad);
  assert.deepEqual(probs({ "in:x": { type: "Spend", category: "Groceries" } }), bad);
  assert.deepEqual(probs({ "out:x": { type: "Transfer", other: "Bank" } }), bad);
  assert.deepEqual(probs({ "out:x": {} }), bad);
});

/* ---------------- the new document ---------------- */
test("new document: start date, pay cycle, new categories, openings; old budget structures gone", () => {
  const old = oldDoc(), pv = M.restartPreview(old, START, TODAY), doc = M.restartDoc(old, choicesFor(pv));
  assert.deepEqual(Object.keys(doc).sort(), ["accounts", "budget", "categories", "income", "incomeCategories", "meta",
    "payCycle", "recurringBills", "rules", "transactions", "wealthSnapshots"]);
  assert.deepEqual(doc.meta, { currency: "GBP", generated: "2026-09-17", source: "test", startDate: START, version: 2 });
  assert.equal(M.isRestarted(doc), true);
  assert.deepEqual(doc.payCycle, { anchor: START, days: 28, overrides: {} });
  assert.deepEqual(doc.categories, M.SPEND_CATS);
  assert.deepEqual(doc.incomeCategories, M.INCOME_CATS);
  assert.deepEqual(doc.accounts, { openingFlex: 1650.96, openingCredit: -18, savings: [{ name: "ISA", balance: 500 }], cash: { n20: 1 } });
  assert.deepEqual(doc.wealthSnapshots, old.wealthSnapshots);
  assert.deepEqual(doc.rules, pv.rules);
  assert.deepEqual(doc.budget, { standard: [{ from: START, cats: pv.budget.cats, savings: 60 }], periods: {} });
});

test("new document: typed openings win over the calculated ones", () => {
  const old = oldDoc(), c = choicesFor(M.restartPreview(old, START, TODAY));
  c.openings = { flex: "1651.20", card: "-18.004" };
  assert.deepEqual([M.restartDoc(old, c).accounts.openingFlex, M.restartDoc(old, c).accounts.openingCredit], [1651.2, -18]);
});

test("new document: kept rows converted to types and new names, review decisions applied, other fields kept", () => {
  const old = oldDoc(), doc = M.restartDoc(old, choicesFor(M.restartPreview(old, START, TODAY)));
  const kind = r => [r.id, r.type, r.category || "→" + (r.to || r.from)];
  assert.deepEqual(doc.transactions.map(kind), [
    ["k1", "Spend", "Groceries"], ["k2", "Spend", "Other"], ["k3", "Spend", "Eating out"], ["k4", "Spend", "Bills"],
    ["k5", "Transfer", "→Card"], ["k6", "Transfer", "→Savings"], ["k7", "Spend", "Other"],
  ]);
  assert.deepEqual(doc.income.map(kind), [
    ["ki1", "Income", "Salary"], ["ki2", "Refund", "Groceries"], ["ki3", "Refund", "Bills"],
    ["ki4", "Transfer", "→Savings"], ["ki5", "Income", "Gifts received"], ["ki6", "Refund", "Eating out"],
  ]);
  for (const r of [...doc.transactions, ...doc.income]) {
    for (const k of ["bill", "billSplits", "source", "sourceSplits"]) assert.equal(k in r, false, r.id + " " + k);
  }
  assert.equal(doc.transactions[0].flagged, true);
  assert.equal(doc.transactions[0].card, "Credit");
});

test("new document: ticked bills only, with the due dates and accounts chosen", () => {
  const old = oldDoc(), doc = M.restartDoc(old, choicesFor(M.restartPreview(old, START, TODAY)));
  assert.deepEqual(doc.recurringBills.map(b => b.id), ["rent", "phone", "bike", "br", "water", "credit-card-repayment"]);
  assert.deepEqual(doc.recurringBills[0], {
    id: "rent", name: "Rent", match: "joel kendall", notes: "", reminder: false, overrides: {},
    versions: [{ from: START, amount: 1050, freq: "monthly", account: "Flex", dueDay: 28 }],
  });
  assert.deepEqual(doc.recurringBills[4].versions, [{ from: START, amount: 180, freq: "yearly", account: "Flex", dueDate: "10-01" }]);
  assert.equal(doc.recurringBills[5].reminder, true);
});

test("new document: balances carry on from the openings exactly as before", () => {
  const old = oldDoc(), doc = M.restartDoc(old, choicesFor(M.restartPreview(old, START, TODAY)));
  for (let d = CLOSE; d <= "2026-10-10"; d = P.addDays(d, 1)) assert.deepEqual(M.balances(doc, d), M.balances(old, d), d);
  assert.deepEqual(M.balances(doc), M.balances(old));
});

test("new document: a review decision that makes a row a transfer moves the card balance", () => {
  const old = oldDoc(), c = choicesFor(M.restartPreview(old, START, TODAY));
  c.review["out:k7"] = { type: "Transfer", other: "Card" };
  const doc = M.restartDoc(old, c);
  assert.deepEqual(doc.transactions[6], { id: "k7", date: "2026-10-08", name: "cash withdrawal", amount: 20, card: "Debit", type: "Transfer", to: "Card" });
  assert.deepEqual(M.balances(doc), { flex: M.balances(old).flex, card: M.round2(M.balances(old).card + 20) });
});

test("new document: works with the Bills and Budget logic", () => {
  const old = oldDoc(), doc = M.restartDoc(old, choicesFor(M.restartPreview(old, START, TODAY)));
  const today = "2026-10-10", period = P.periodFor(M.cycleOf(doc), today);
  assert.deepEqual([period.start, period.end], [START, "2026-10-15"]);
  const b = M.periodBudget(doc, period, today);
  // due: rent 1050 (paid 28 Sep), phone 11.41, bike 197.63, water 180; the card reminder isn't counted
  assert.deepEqual(b.bills.totals.due, 1439.04);
  assert.deepEqual(b.bills.totals.paid, 1050);
  const status = Object.fromEntries(b.bills.items.map(i => [i.bill.id, i.status]));
  assert.deepEqual(status, { rent: "paid", phone: "overdue", bike: "overdue", water: "overdue", "credit-card-repayment": "paid" });
  const row = c => b.rows.find(r => r.category === c);
  assert.deepEqual([row("Bills").budget, row("Bills").spent], [1439.04, 650], "rent paid less the flatmate's 400");
  assert.deepEqual([row("Groceries").budget, row("Groceries").spent], [231, 25]);
  assert.deepEqual([row("Eating out").budget, row("Eating out").spent], [18, 8]);
  assert.deepEqual([row("Other").budget, row("Other").spent], [92, 45]);
  assert.deepEqual([b.savings.target, b.savings.saved], [60, -50]);
  assert.equal(b.pay.amount, 2100);
  assert.equal(b.summary.unallocated, 28.96);   // 2100 − 1439.04 − 572 − 60
  const u = M.untilPayday(doc, today);
  // Flex 1650.96 − 1050 − 60 − 50 − 20 + 2100 + 400 + 100 + 50; card −18 − 30 − 25 − 15 + 60 + 5 + 7
  assert.deepEqual([u.flex, u.card, u.cardOwed, u.billsDue, u.safe, u.daysLeft], [3120.96, -16, 16, 389.04, 2715.92, 6]);
});

test("restart never changes the old document (it is the archive)", () => {
  const old = oldDoc(), before = JSON.stringify(old);
  const c = choicesFor(M.restartPreview(old, START, TODAY));
  M.restartDoc(old, c);
  assert.equal(JSON.stringify(old), before);
});

/* ---------------- a copy of the real data ---------------- */
const DATA_FILE = process.env.BUDGET_DATA || path.join(__dirname, "..", "local", "budget-data.json");
const real = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : null;
const skip = real ? false : "no copy of the budget data (set BUDGET_DATA)";

// The Accounts tab's balance sums as app.js does them before the restart.
function accountsTab(doc, upto) {
  const cats = doc.categories, sum = rows => rows.reduce((s, t) => s + t.amount, 0);
  const tx = doc.transactions.filter(t => t.date <= upto), inc = doc.income.filter(t => t.date <= upto);
  const debit = t => (t.card || "Debit") === "Debit", credit = t => (t.card || "Debit") === "Credit";
  const repaid = sum(tx.filter(t => debit(t) && !cats.includes(t.category)));
  return {
    flex: M.round2(doc.accounts.openingFlex - sum(tx.filter(t => debit(t) && cats.includes(t.category))) + sum(inc.filter(t => !credit(t))) - repaid),
    card: M.round2(doc.accounts.openingCredit - sum(tx.filter(credit)) + repaid + sum(inc.filter(credit))),
  };
}
// The copy may have nothing from 18 Sep on, so add rows like a statement import would.
function withNewRows(doc) {
  const d = JSON.parse(JSON.stringify(doc));
  d.transactions.push(
    tx("restart-test-1", "2026-09-18", "tesco stores 1234", 12.5, "Credit", "Groceries"),
    tx("restart-test-2", "2026-09-25", "MEMBER CREDIT CARD", 400, "Debit", "Credit"),
    tx("restart-test-3", "2026-09-26", "moneybox", 25, "Debit", "Savings"),
    tx("restart-test-4", "2026-10-01", "amazon", 20, "Credit", "Other"));
  d.income.push(
    inc("restart-test-5", "2026-09-18", "payroll", 2000, "Debit", "Salary"),
    inc("restart-test-6", "2026-09-30", "someone", 10, "Debit", "Other"));
  return d;
}
// The preview accepted as it is, with every due date filled in.
const filled = pv => ({
  start: pv.start, openings: pv.openings, budget: pv.budget, review: {},
  bills: pv.bills.map(b => ({ ...b, dueDay: b.freq === "monthly" ? 1 : null, dueDate: b.freq === "yearly" ? "01-01" : null })),
});

test("real data: openings are the Accounts tab's balances at the close of 17 Sep", { skip }, () => {
  const copy = withNewRows(real), pv = M.restartPreview(copy, START, TODAY);
  assert.deepEqual(pv.openings, accountsTab(copy, CLOSE));
  if (![...real.transactions, ...real.income].some(r => r.date > CLOSE)) {
    assert.deepEqual(pv.openings, accountsTab(real, "9999-12-31"), "nothing after 17 Sep yet: the Accounts tab today");
  }
});

test("real data: counts add up, nothing from 18 Sep on is lost, every kept row is typed", { skip }, () => {
  const copy = withNewRows(real), pv = M.restartPreview(copy, START, TODAY);
  const keptIds = rows => rows.filter(r => r.date >= START).map(r => r.id);
  assert.deepEqual(pv.counts, {
    kept: { out: keptIds(copy.transactions).length, in: keptIds(copy.income).length },
    archived: { out: copy.transactions.length - keptIds(copy.transactions).length, in: copy.income.length - keptIds(copy.income).length },
  });
  const doc = M.restartDoc(copy, filled(pv));
  assert.deepEqual(doc.transactions.map(r => r.id), keptIds(copy.transactions));
  assert.deepEqual(doc.income.map(r => r.id), keptIds(copy.income));
  const names = new Set([...M.SPEND_CATS, ...M.INCOME_CATS]);
  for (const r of [...doc.transactions, ...doc.income]) {
    assert.ok(M.TYPES.includes(r.type), r.id);
    if (r.type === "Transfer") assert.ok(M.TRANSFER_ACCOUNTS.includes(r.to || r.from), r.id);
    else assert.ok(names.has(r.category), r.id + " " + r.category);
    for (const k of ["bill", "billSplits", "source", "sourceSplits"]) assert.equal(k in r, false, r.id + " " + k);
  }
});

test("real data: Flex and card balances carry on unchanged from 17 Sep", { skip }, () => {
  const copy = withNewRows(real), pv = M.restartPreview(copy, START, TODAY);
  const doc = M.restartDoc(copy, filled(pv));
  const dates = [CLOSE, ...new Set([...copy.transactions, ...copy.income].map(r => r.date).filter(d => d > CLOSE))].sort();
  for (const d of dates) assert.deepEqual(M.balances(doc, d), accountsTab(copy, d), d);
});

test("real data: every old bill is drafted once, plus the card reminder; due dates filled → no problems", { skip }, () => {
  const pv = M.restartPreview(withNewRows(real), START, TODAY);
  assert.equal(pv.bills.length, real.bills.length + (real.yearlyBills || []).length + 1);
  assert.equal(new Set(pv.bills.map(b => b.id)).size, pv.bills.length, "unique ids");
  const c = filled(pv);
  assert.deepEqual(M.restartProblems(c), []);
  const doc = M.restartDoc(real, c);
  assert.equal(doc.recurringBills.length, c.bills.filter(b => b.include).length);
});

test("real data: every rule is kept under the new names; Savings rules become transfers", { skip }, () => {
  const rules = M.restartPreview(real, START, TODAY).rules;
  const byMatch = Object.fromEntries(rules.map(r => [r.match, r]));
  for (const r of real.rules) {
    const n = byMatch[String(r.match).trim().toLowerCase()];
    assert.ok(n, r.match);
    if (r.category === "Savings") assert.deepEqual(n, { match: n.match, transfer: "Savings" });
  }
  for (const r of rules) if (!r.transfer) assert.ok(M.SPEND_CATS.includes(r.category) || M.INCOME_CATS.includes(r.category), r.match);
  assert.deepEqual(byMatch["member credit card"], { match: "member credit card", transfer: "Card" });
});

test("real data: the old document is untouched", { skip }, () => {
  const copy = withNewRows(real), before = JSON.stringify(copy);
  M.restartDoc(copy, filled(M.restartPreview(copy, START, TODAY)));
  assert.equal(JSON.stringify(copy), before);
});
