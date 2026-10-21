"use strict";
// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/js/model.js");
const P = require("../public/js/periods.js");

const C = P.DEFAULT_CYCLE;
const K0 = "2026-09-18", K1 = "2026-10-16", K2 = "2026-11-13", K3 = "2026-12-11";
const per = key => P.periodByKey(C, key);           // K1 = 16 Oct – 12 Nov 2026
const TODAY = "2026-11-06";
const monthly = (amount, dueDay, account = "Flex") => [{ from: K0, amount, freq: "monthly", dueDay, account }];
const spend = (id, date, name, amount, category, card = "Debit", extra = {}) =>
  Object.assign({ id, date, name, amount, card, type: "Spend", category }, extra);

function mkDoc() {
  return {
    meta: { startDate: K0, version: 2 },
    payCycle: { anchor: K0, days: 28, overrides: {} },
    categories: M.SPEND_CATS.slice(),
    incomeCategories: M.INCOME_CATS.slice(),
    accounts: { openingFlex: 1000, openingCredit: -200 },
    budget: { standard: [{ from: K0, cats: { Groceries: 230, "Pub & Social": 120, "Eating out": 60 }, savings: 300 }], periods: {} },
    recurringBills: [
      { id: "rent", name: "Rent", match: "landlord", versions: monthly(675, 1) },
      { id: "phone", name: "Phone", match: "vodafone", versions: monthly(12, 14) },
      { id: "claude", name: "Claude", match: "claude", versions: monthly(18, 20, "Card") },
      { id: "netflix", name: "Netflix", match: "netflix", versions: monthly(11, 10, "Card") },
      { id: "card", name: "Credit card", match: "member credit card", reminder: true, versions: monthly(0, 5) },
    ],
    transactions: [
      spend("t1", "2026-10-16", "VODAFONE LTD", 12, "Bills"),            // pays the phone bill due 14 Oct (previous period)
      spend("t2", "2026-10-31", "LANDLORD RENT", 675, "Bills"),
      spend("t3", "2026-10-20", "CLAUDE.AI", 18, "Other", "Credit"),     // pays a bill, so counts as Bills
      spend("t4", "2026-10-18", "TESCO", 50, "Groceries", "Credit"),
      spend("t5", "2026-10-25", "SAINSBURYS", 40, "Groceries", "Debit", { categorySplits: [{ category: "Groceries", amount: 30 }, { category: "Home", amount: 5 }] }),
      { id: "t6", date: "2026-11-05", name: "MEMBER CREDIT CARD", amount: 200, card: "Debit", type: "Transfer", to: "Card" },
      { id: "t7", date: "2026-10-30", name: "MONEYBOX", amount: 300, card: "Debit", type: "Transfer", to: "Savings" },
      spend("t8", "2026-11-12", "THE PUB", 25, "Pub & Social", "Credit", { countIn: K2 }),
      spend("t9", "2026-10-10", "OLD PUB", 30, "Pub & Social", "Credit", { countIn: K1 }),
      spend("t10", "2026-10-22", "WATER CO", 20, "Bills"),               // no bill matches it
      spend("t11", "2026-10-26", "MODEL SHOP", 15, "Hobbies", "Credit"),  // a category that isn't in the list
    ],
    income: [
      { id: "i0", date: "2026-09-18", name: "EMPLOYER", amount: 2350, card: "Debit", type: "Income", category: "Salary" },
      { id: "i1", date: "2026-10-16", name: "EMPLOYER", amount: 2400, card: "Debit", type: "Income", category: "Salary" },
      { id: "i2", date: "2026-10-28", name: "TESCO REFUND", amount: 10, card: "Credit", type: "Refund", category: "Groceries" },
      { id: "i3", date: "2026-11-01", name: "MONEYBOX", amount: 50, card: "Debit", type: "Transfer", from: "Savings" },
    ],
  };
}
const rowOf = (b, cat) => b.rows.find(r => r.category === cat);
const brief = r => [r.category, r.budget, r.spent, r.left];

/* ---------------- spent, saved and income in a period ---------------- */
test("spent is Spend − Refund per category; transfers count nowhere; savings are net", () => {
  const doc = mkDoc();
  const f = M.periodFlows(doc, per(K1), new Set(["t1", "t2", "t3"]));
  assert.deepEqual(f.spent, { Groceries: 75, Home: 5, "Pub & Social": 30, Bills: 20, Hobbies: 15 },
    "Tesco 50 + Sainsbury's 35 (30 split + 5 not split) − refund 10; card repayment and Moneybox left out");
  assert.equal(f.saved, 250, "300 to savings − 50 back");
  assert.deepEqual(f.income, { Salary: 2400 });
  assert.equal(f.billPayments, 705, "bill payments dated in the period, kept out of spent");
});

test("'count in another period' moves a row's budget period but not its balance", () => {
  const doc = mkDoc();
  assert.equal(M.rowPeriodKey(doc, doc.transactions[7]), K2, "12 Nov counted in the next period");
  assert.equal(M.rowPeriodKey(doc, doc.transactions[8]), K1, "10 Oct counted in this period");
  assert.equal(M.rowPeriodKey(doc, { date: "2026-10-20", countIn: "2026-10-17" }), K1, "not a payday: use the date");
  assert.equal(M.rowPeriodKey(doc, { amount: 1 }), null, "no date, no period");
  assert.equal(M.periodFlows(doc, per(K2)).spent["Pub & Social"], 25);
  assert.equal(M.periodFlows(doc, per(K0)).spent["Pub & Social"], undefined);
  const plain = mkDoc();
  plain.transactions.forEach(r => delete r.countIn);
  for (const d of ["2026-10-10", "2026-11-12", "2026-12-31"]) assert.deepEqual(M.balances(doc, d), M.balances(plain, d));
});

/* ---------------- the Budget tab ---------------- */
test("a period's budget: Bills from the Bills tab, categories from the standard budget", () => {
  const b = M.periodBudget(mkDoc(), per(K1), TODAY);
  assert.deepEqual(b.rows.map(brief), [
    ["Bills", 704, 713, -9],
    ["Groceries", 230, 75, 155],
    ["Pub & Social", 120, 30, 90],
    ["Eating out", 60, 0, 60],
    ["Transport", 0, 0, 0],
    ["Shopping", 0, 0, 0],
    ["Health & Personal", 0, 0, 0],
    ["Home", 0, 5, -5],
    ["Gifts", 0, 0, 0],
    ["Other", 0, 0, 0],
    ["Hobbies", 0, 15, -15],
  ]);
  assert.equal(rowOf(b, "Bills").budget, b.bills.totals.due, "the Bills row is the Bills tab's total");
  assert.deepEqual(b.totals, { budget: 1114, spent: 838, left: 276 });
  assert.deepEqual(b.savings, { target: 300, standard: 300, edited: false, saved: 250 });
  assert.deepEqual(b.summary, { pay: 2400, billsDue: 704, budgets: 410, savings: 300, unallocated: 986 },
    "2400 − 704 − 410 − 300");
});

test("a bill paid just after payday counts in the period it was due", () => {
  const doc = mkDoc();
  const b0 = M.periodBudget(doc, per(K0), TODAY), b1 = M.periodBudget(doc, per(K1), TODAY);
  assert.deepEqual(brief(rowOf(b0, "Bills")), ["Bills", 716, 12, 704], "phone due 14 Oct, paid 16 Oct");
  assert.equal(rowOf(b1, "Bills").spent, 713, "693 for this period's bills + 20 not matched to a bill; not the phone");
  assert.equal(rowOf(b1, "Other").spent, 0, "Claude paid a bill, so it isn't Other");
  const tl = M.billTimeline(doc, "2027-01-31");
  assert.deepEqual(M.periodBudget(doc, per(K1), TODAY, tl).rows, b1.rows, "same answer with a shared timeline");
});

test("a bill paid by hand counts as Bills spent", () => {
  const doc = mkDoc();
  M.overrideBill(doc.recurringBills[3], "2026-11", { paid: { date: "2026-11-02", amount: 11 } });
  const b = M.periodBudget(doc, per(K1), TODAY);
  assert.deepEqual(brief(rowOf(b, "Bills")), ["Bills", 704, 724, -20]);
});

test("pay: typed › received › last pay for the current or a future period › none", () => {
  const doc = mkDoc();
  assert.deepEqual(M.periodBudget(doc, per(K1), TODAY).pay, { amount: 2400, source: "received", received: 2400 });
  assert.deepEqual(M.periodBudget(doc, per(K2), TODAY).pay, { amount: 2400, source: "last", received: 0, from: K1 });
  M.setPay(doc, K2, 2500);
  const b2 = M.periodBudget(doc, per(K2), TODAY);
  assert.deepEqual([b2.pay.amount, b2.pay.source, b2.summary.pay], [2500, "typed", 2500]);
  M.setPay(doc, K2, null);
  assert.equal(M.periodBudget(doc, per(K2), TODAY).pay.source, "last");
  assert.deepEqual(doc.budget.periods, {}, "clearing the pay leaves nothing behind");
  assert.deepEqual(M.periodBudget(doc, per(K2), "2027-01-01").pay, { amount: 0, source: "none", received: 0 },
    "a period that has ended with no salary had no pay");
});

/* ---------------- editing the budget ---------------- */
test("'this period only' shows as edited and can be reset to standard", () => {
  const doc = mkDoc();
  M.setBudget(doc, K1, "Pub & Social", 150, "period");
  assert.deepEqual(M.budgetFor(doc, K1).cats["Pub & Social"], { amount: 150, standard: 120, edited: true });
  assert.deepEqual(M.budgetFor(doc, K2).cats["Pub & Social"], { amount: 120, standard: 120, edited: false });
  assert.equal(rowOf(M.periodBudget(doc, per(K1), TODAY), "Pub & Social").edited, true);
  M.resetBudget(doc, K1, "Pub & Social");
  assert.deepEqual(M.budgetFor(doc, K1).cats["Pub & Social"], { amount: 120, standard: 120, edited: false });
  assert.deepEqual(doc.budget.periods, {});
  M.setBudget(doc, K1, null, 400, "period");
  assert.deepEqual(M.budgetFor(doc, K1).savings, { amount: 400, standard: 300, edited: true });
  assert.equal(M.periodBudget(doc, per(K1), TODAY).summary.unallocated, 886);
});

test("'this and future periods' changes the standard from that period on", () => {
  const doc = mkDoc();
  const groceries = key => M.budgetFor(doc, key).cats.Groceries.amount;
  M.setBudget(doc, K2, "Groceries", 250, "future");
  assert.deepEqual([K0, K1, K2, K3].map(groceries), [230, 230, 250, 250]);
  assert.deepEqual(doc.budget.standard.map(v => v.from), [K0, K2]);
  // a period-only figure is replaced, and later standards follow the new figure
  M.setBudget(doc, K1, "Groceries", 200, "period");
  M.setBudget(doc, K1, "Groceries", 240, "future");
  assert.deepEqual([K0, K1, K2, K3].map(groceries), [230, 240, 240, 240]);
  assert.equal(M.budgetFor(doc, K1).cats.Groceries.edited, false);
  assert.deepEqual(doc.budget.periods, {});
  assert.equal(M.budgetFor(doc, K2).cats["Pub & Social"].amount, 120, "other categories untouched");
  M.setBudget(doc, K3, null, 350, "future");
  assert.deepEqual([K2, K3].map(k => M.budgetFor(doc, k).savings.amount), [300, 350]);
  M.setBudget(doc, K2, "Shopping", 40, "future");
  assert.deepEqual([K1, K2, K3].map(k => (M.budgetFor(doc, k).cats.Shopping || {}).amount), [undefined, 40, 40]);
});

/* ---------------- paydays ---------------- */
test("a payday can be moved by less than half a period, and put back", () => {
  const doc = mkDoc();
  assert.equal(M.setPayday(doc, K1, "2026-10-15"), true, "paid a day early");
  assert.equal(P.periodFor(doc.payCycle, "2026-10-15").key, K1);
  assert.equal(P.periodFor(doc.payCycle, "2026-10-14").key, K0);
  assert.equal(M.rowPeriodKey(doc, { date: "2026-10-15" }), K1);
  assert.equal(M.setPayday(doc, K1, "2026-10-30"), false, "14 days is too far");
  assert.equal(M.setPayday(doc, "2026-10-17", "2026-10-16"), false, "not a payday");
  assert.deepEqual(doc.payCycle.overrides, { [K1]: "2026-10-15" });
  assert.equal(M.setPayday(doc, K1, null), true);
  assert.deepEqual(doc.payCycle.overrides, {});
  M.setPayday(doc, K1, "2026-10-15");
  M.setPayday(doc, K1, K1);
  assert.deepEqual(doc.payCycle.overrides, {}, "setting the usual date clears it");
});

/* ---------------- until payday ---------------- */
test("safe to spend = Flex − card owed − bills still to pay before payday (either account)", () => {
  const u = M.untilPayday(mkDoc(), TODAY);
  assert.equal(u.period.key, K1);
  assert.deepEqual([u.daysLeft, u.flex, u.card, u.cardOwed, u.billsDue], [7, 4553, -103, 103, 11]);
  assert.deepEqual(u.bills.map(i => i.bill.id), ["netflix"], "rent and Claude are paid; the card reminder is a transfer");
  assert.deepEqual([u.safe, u.perDay], [4439, 634.14], "4553 − 103 − 11, over 7 days");
  // a card purchase lowers safe to spend straight away
  const doc = mkDoc();
  doc.transactions.push(spend("t12", TODAY, "TESCO", 40, "Groceries", "Credit"));
  assert.equal(M.untilPayday(doc, TODAY).safe, 4399);
  // once Netflix is charged it moves from bills to the card balance: no change
  doc.transactions.push(spend("t13", "2026-11-10", "NETFLIX.COM", 11, "Bills", "Credit"));
  const later = M.untilPayday(doc, "2026-11-10");
  assert.deepEqual([later.billsDue, later.cardOwed, later.safe], [0, 154, 4399]);
  assert.equal(later.perDay, 1466.33, "3 days left");
});
