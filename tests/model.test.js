"use strict";
// Run with: node --test tests/
// The real-data checks read a COPY of the budget document, never the live one:
//   BUDGET_DATA=/path/to/copy.json node --test tests/
// (default: local/budget-data.json; skipped when there's no file, e.g. in CI).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../public/js/model.js");

const OLD_CATS = ["Bills", "Groceries", "Pub/Social", "Takeaway/Restaurant", "Travel/Car", "Gifts", "Other", "Savings"];
const out = (category, amount = 10, card = "Debit", extra = {}) => ({ id: "t", date: "2026-09-20", name: "X", amount, card, category, ...extra });
const inn = (source, amount = 10, card = "Debit", extra = {}) => ({ id: "i", date: "2026-09-20", name: "X", amount, card, source, ...extra });

// The balance rules exactly as renderAccounts / ledgerAll in app.js apply
// them today; everything in model.js must agree with these on old data.
function oldBalances(doc, upto) {
  const a = doc.accounts, cats = doc.categories;
  const tx = doc.transactions.filter(t => !upto || t.date <= upto);
  const inc = doc.income.filter(t => !upto || t.date <= upto);
  const sum = rows => rows.reduce((s, t) => s + t.amount, 0);
  const debitSpend = sum(tx.filter(t => (t.card || "Debit") === "Debit" && cats.includes(t.category)));
  const creditPaid = sum(tx.filter(t => (t.card || "Debit") === "Debit" && !cats.includes(t.category)));
  const creditCharges = sum(tx.filter(t => (t.card || "Debit") === "Credit"));
  const flexIncome = sum(inc.filter(t => (t.card || "Debit") !== "Credit"));
  const creditRefunds = sum(inc.filter(t => (t.card || "Debit") === "Credit"));
  return {
    flex: M.round2(a.openingFlex - debitSpend + flexIncome - creditPaid),
    card: M.round2(a.openingCredit - creditCharges + creditPaid + creditRefunds),
  };
}
function oldEffects(row, dir, cats) {
  const card = row.card || "Debit", amt = row.amount;
  if (dir === "out") {
    if (card === "Debit") return { Flex: -amt, Card: cats.includes(row.category) ? 0 : amt };
    return { Flex: 0, Card: -amt };
  }
  return card === "Credit" ? { Flex: 0, Card: amt } : { Flex: amt, Card: 0 };
}
function convertAll(doc) {
  const cats = doc.categories;
  return {
    ...doc, categories: M.SPEND_CATS.slice(),
    transactions: doc.transactions.map(r => M.convertRow(r, "out", cats)),
    income: doc.income.map(r => M.convertRow(r, "in", cats)),
  };
}
const same = (a, b, msg) => assert.deepEqual({ Flex: a.Flex + 0, Card: a.Card + 0 }, { Flex: b.Flex + 0, Card: b.Card + 0 }, msg);

/* ---------------- classify ---------------- */
test("old money-out rows: Savings and card repayments are transfers, the rest is spending", () => {
  assert.deepEqual(M.classify(out("Savings"), "out", OLD_CATS), { type: "Transfer", category: null, other: "Savings" });
  assert.deepEqual(M.classify(out("Credit"), "out", OLD_CATS), { type: "Transfer", category: null, other: "Card" });
  assert.deepEqual(M.classify(out("Groceries"), "out", OLD_CATS), { type: "Spend", category: "Groceries", other: null });
  assert.deepEqual(M.classify(out("Other", 5, "Credit"), "out", OLD_CATS), { type: "Spend", category: "Other", other: null });
});

test("old money-in rows: income, transfers from savings, and paybacks as refunds", () => {
  const k = s => M.classify(inn(s), "in", OLD_CATS);
  assert.equal(k("Salary").type, "Income");
  assert.equal(k("Presents").type, "Income");
  assert.equal(k("Gifts").type, "Income", "Gifts money-in is a present, not a refund");
  assert.deepEqual(k("Savings"), { type: "Transfer", category: null, other: "Savings" });
  assert.deepEqual(k("Bills"), { type: "Refund", category: "Bills", other: null });
  assert.deepEqual(k("Other"), { type: "Refund", category: "Other", other: null }, "the old dashboard netted Other money-in off Other");
  assert.deepEqual(k("Reimbursement"), { type: "Refund", category: "Other", other: null });
  assert.deepEqual(k("Bonus"), { type: "Income", category: "Bonus", other: null });
});

test("typed rows are read as stored", () => {
  assert.deepEqual(M.classify({ type: "Spend", category: "Shopping", amount: 1 }, "out", OLD_CATS), { type: "Spend", category: "Shopping", other: null });
  assert.deepEqual(M.classify({ type: "Transfer", to: "Card", category: "Groceries" }, "out", []), { type: "Transfer", category: null, other: "Card" });
  assert.deepEqual(M.classify({ type: "Transfer", from: "Savings" }, "in", []), { type: "Transfer", category: null, other: "Savings" });
  assert.deepEqual(M.classify({ type: "Income", category: "Salary" }, "in", []), { type: "Income", category: "Salary", other: null });
});

/* ---------------- effects on the two accounts ---------------- */
test("each kind of row moves the right accounts", () => {
  same(M.effects(out("Groceries", 10), "out", OLD_CATS), { Flex: -10, Card: 0 });
  same(M.effects(out("Groceries", 10, "Credit"), "out", OLD_CATS), { Flex: 0, Card: -10 });
  same(M.effects(out("Credit", 300), "out", OLD_CATS), { Flex: -300, Card: 300 }, "card repayment: out of Flex, onto the card");
  same(M.effects(out("Savings", 50), "out", OLD_CATS), { Flex: -50, Card: 0 }, "savings balances are typed in, not derived");
  same(M.effects(inn("Salary", 1000), "in", OLD_CATS), { Flex: 1000, Card: 0 });
  same(M.effects(inn("Travel/Car", 19.6, "Credit"), "in", OLD_CATS), { Flex: 0, Card: 19.6 }, "card refunds stay on the card");
  same(M.effects({ type: "Transfer", to: "Card", card: "Debit", amount: 300 }, "out"), { Flex: -300, Card: 300 });
  same(M.effects({ type: "Transfer", from: "Card", card: "Debit", amount: 40 }, "in"), { Flex: 40, Card: -40 });
  same(M.effects({ type: "Transfer", to: "Savings", card: "Debit", amount: 25 }, "out"), { Flex: -25, Card: 0 });
  same(M.effects({ type: "Spend", category: "Bills", card: "Credit", amount: 12 }, "out"), { Flex: 0, Card: -12 });
});

test("ledger orders by date, money in before money out, and keeps running balances", () => {
  const doc = {
    categories: OLD_CATS, accounts: { openingFlex: 100, openingCredit: -50 },
    transactions: [
      { id: "a", date: "2026-09-19", amount: 30, card: "Debit", category: "Groceries" },
      { id: "b", date: "2026-09-19", amount: 50, card: "Debit", category: "Credit" },
      { id: "c", date: "2026-09-18", amount: 20, card: "Credit", category: "Pub/Social" },
    ],
    income: [{ id: "d", date: "2026-09-19", amount: 1000, card: "Debit", source: "Salary" }],
  };
  const L = M.ledger(doc);
  assert.deepEqual(L.map(r => r.row.id), ["c", "d", "a", "b"]);
  assert.deepEqual(L.map(r => [r.flexBal, r.cardBal]), [[undefined, -70], [1100, undefined], [1070, undefined], [1020, -20]]);
  assert.deepEqual(M.balances(doc), { flex: 1020, card: -20 });
  assert.deepEqual(M.balances(doc, "2026-09-18"), { flex: 100, card: -70 });
  assert.deepEqual(M.balances(doc), oldBalances(doc));
});

/* ---------------- converting old rows ---------------- */
test("old spending categories map to the new names (plan 3.6)", () => {
  const map = { "Bills": "Bills", "Groceries": "Groceries", "Pub/Social": "Pub & Social", "Takeaway/Restaurant": "Eating out",
    "Travel/Car": "Transport", "Gifts": "Gifts", "Other": "Other" };
  for (const [from, to] of Object.entries(map)) {
    const r = M.convertRow(out(from), "out", OLD_CATS);
    assert.equal(r.type, "Spend", from); assert.equal(r.category, to, from);
  }
  const sav = M.convertRow(out("Savings"), "out", OLD_CATS);
  assert.equal(sav.type, "Transfer"); assert.equal(sav.to, "Savings"); assert.equal(sav.category, undefined);
  const rep = M.convertRow(out("Credit"), "out", OLD_CATS);
  assert.equal(rep.type, "Transfer"); assert.equal(rep.to, "Card"); assert.equal(rep.category, undefined);
});

test("old money-in sources map to Income, Transfer or Refund (plan 3.6)", () => {
  const c = s => { const r = M.convertRow(inn(s), "in", OLD_CATS); return [r.type, r.category || r.from]; };
  assert.deepEqual(c("Salary"), ["Income", "Salary"]);
  assert.deepEqual(c("Presents"), ["Income", "Gifts received"]);
  assert.deepEqual(c("Gifts"), ["Income", "Gifts received"]);
  assert.deepEqual(c("Savings"), ["Transfer", "Savings"]);
  assert.deepEqual(c("Bills"), ["Refund", "Bills"]);
  assert.deepEqual(c("Pub/Social"), ["Refund", "Pub & Social"]);
  assert.deepEqual(c("Takeaway/Restaurant"), ["Refund", "Eating out"]);
  assert.deepEqual(c("Travel/Car"), ["Refund", "Transport"]);
  assert.deepEqual(c("Other"), ["Refund", "Other"]);
  assert.deepEqual(c("Bonus"), ["Income", "Other income"]);
});

test("conversion drops bill links and old fields but keeps everything else", () => {
  const r = M.convertRow(out("Bills", 500, "Debit", { bill: "Rent", billSplits: [{ bill: "Rent", amount: 500 }], note: "keep me", countIn: "2026-10-16", confirmed: false }), "out", OLD_CATS);
  assert.deepEqual(r, { id: "t", date: "2026-09-20", name: "X", amount: 500, card: "Debit", note: "keep me", countIn: "2026-10-16", confirmed: false, type: "Spend", category: "Bills" });
  const i = M.convertRow(inn("Other", 15, "Debit", { sourceSplits: [{ source: "Other", amount: 5 }, { source: "Travel/Car", amount: 3 }, { source: "Pub/Social", amount: 7 }] }), "in", OLD_CATS);
  assert.equal(i.source, undefined); assert.equal(i.sourceSplits, undefined);
  assert.deepEqual(i.categorySplits, [{ category: "Other", amount: 5 }, { category: "Transport", amount: 3 }, { category: "Pub & Social", amount: 7 }]);
  const s = M.convertRow(out("Other", 20, "Debit", { categorySplits: [{ category: "Takeaway/Restaurant", amount: 12 }, { category: "Other", amount: 8 }] }), "out", OLD_CATS);
  assert.deepEqual(s.categorySplits, [{ category: "Eating out", amount: 12 }, { category: "Other", amount: 8 }]);
});

test("typed rows still carrying old names are renamed, and new names are left alone", () => {
  assert.equal(M.convertRow({ type: "Spend", category: "Travel/Car", amount: 1 }, "out", OLD_CATS).category, "Transport");
  assert.equal(M.convertRow({ type: "Refund", category: "Pub/Social", amount: 1 }, "in", OLD_CATS).category, "Pub & Social");
  assert.equal(M.convertRow({ type: "Income", category: "Presents", amount: 1 }, "in", OLD_CATS).category, "Gifts received");
  assert.equal(M.convertRow({ type: "Spend", category: "Health & Personal", amount: 1 }, "out", OLD_CATS).category, "Health & Personal");
  assert.deepEqual(M.convertRow({ type: "Transfer", to: "Savings", category: "Savings", amount: 1 }, "out", OLD_CATS), { amount: 1, card: "Debit", type: "Transfer", to: "Savings" });
});

test("rows the wizard should ask about", () => {
  assert.equal(M.needsReview(out("Other"), "out"), true);
  assert.equal(M.needsReview(out("Groceries"), "out"), false);
  assert.equal(M.needsReview(out("Credit"), "out"), false);
  assert.equal(M.needsReview(inn("Other"), "in"), true);
  assert.equal(M.needsReview(inn("Reimbursement"), "in"), true);
  assert.equal(M.needsReview(inn(undefined), "in"), true);
  for (const s of ["Salary", "Presents", "Gifts", "Savings", "Bills", "Pub/Social"]) assert.equal(M.needsReview(inn(s), "in"), false, s);
  assert.equal(M.needsReview({ type: "Spend", category: "Other" }, "out"), false, "already typed");
});

/* ---------------- rules ---------------- */
test("rules are tidied, the longest match wins, and transfers are kept", () => {
  const rules = M.normaliseRules([
    { match: "Tesco", category: "Groceries" }, { match: "tesco ", category: "Other" },
    { match: "TESCO EXPRESS", category: "Eating out" }, { match: "moneybox", transfer: "Savings" }, { match: "  " },
  ]);
  assert.deepEqual(rules, [{ match: "tesco express", category: "Eating out" }, { match: "moneybox", transfer: "Savings" }, { match: "tesco", category: "Groceries" }]);
  assert.equal(M.ruleFor(rules, "TESCO EXPRESS BRIGHTON").category, "Eating out");
  assert.equal(M.ruleFor(rules, "Tesco Stores").category, "Groceries");
  assert.equal(M.ruleFor(rules, "Sainsbury's"), null);
});

test("what a rule makes of money out and money in", () => {
  assert.deepEqual(M.fromRule({ match: "moneybox", transfer: "Savings" }, "in"), { type: "Transfer", category: null, other: "Savings" });
  assert.deepEqual(M.fromRule({ match: "tesco", category: "Groceries" }, "out"), { type: "Spend", category: "Groceries", other: null });
  assert.deepEqual(M.fromRule({ match: "tesco", category: "Groceries" }, "in"), { type: "Refund", category: "Groceries", other: null });
  assert.deepEqual(M.fromRule({ match: "acme ltd", category: "Salary" }, "in"), { type: "Income", category: "Salary", other: null });
  assert.equal(M.fromRule(null, "out"), null);
});

test("setKind writes a type onto a row and clears what no longer applies", () => {
  const r = M.setKind({ category: "Savings", amount: 5, bill: "x" }, "out", { type: "Transfer", other: "Savings" });
  assert.deepEqual(r, { amount: 5, bill: "x", type: "Transfer", to: "Savings" });
  const s = M.setKind({ type: "Transfer", from: "Savings", source: "Savings", amount: 5 }, "in", { type: "Refund", category: "Bills" });
  assert.deepEqual(s, { type: "Refund", amount: 5, category: "Bills" });
});

/* ---------------- a copy of the real data ---------------- */
const DATA_FILE = process.env.BUDGET_DATA || path.join(__dirname, "..", "local", "budget-data.json");
const real = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : null;
const skip = real ? false : "no copy of the budget data (set BUDGET_DATA)";

test("real data: every row is on the Debit or Credit card", { skip }, () => {
  for (const r of [...real.transactions, ...real.income]) assert.ok(r.card === "Debit" || r.card === "Credit", r.id);
});

test("real data: each row moves the accounts exactly as the old rules did, before and after conversion", { skip }, () => {
  const cats = real.categories;
  for (const [rows, dir] of [[real.transactions, "out"], [real.income, "in"]]) {
    for (const r of rows) {
      same(M.effects(r, dir, cats), oldEffects(r, dir, cats), r.id);
      same(M.effects(M.convertRow(r, dir, cats), dir, M.SPEND_CATS), oldEffects(r, dir, cats), r.id + " converted");
    }
  }
});

test("real data: identical Flex and card balances at the close of every day, before and after conversion", { skip }, () => {
  const conv = convertAll(real);
  const dates = [...new Set([...real.transactions, ...real.income].map(r => r.date))].sort();
  for (const d of dates) {
    const want = oldBalances(real, d);
    assert.deepEqual(M.balances(real, d), want, d);
    assert.deepEqual(M.balances(conv, d), want, d + " converted");
  }
  assert.deepEqual(M.balances(real), oldBalances(real));
  assert.deepEqual(M.balances(conv), oldBalances(real));
  const L = M.ledger(conv), lastFlex = L.filter(r => r.affectsFlex).pop(), lastCard = L.filter(r => r.affectsCard).pop();
  assert.deepEqual({ flex: lastFlex.flexBal, card: lastCard.cardBal }, oldBalances(real));
});

test("real data: converted rows all have a type and only new names", { skip }, () => {
  const conv = convertAll(real);
  const cats = new Set([...M.SPEND_CATS, ...M.INCOME_CATS]);
  for (const r of [...conv.transactions, ...conv.income]) {
    assert.ok(M.TYPES.includes(r.type), r.id);
    if (r.type === "Transfer") assert.ok(M.TRANSFER_ACCOUNTS.includes(r.to || r.from), r.id);
    else assert.ok(cats.has(r.category), r.id + " " + r.category);
    if (r.type === "Income") assert.ok(M.INCOME_CATS.includes(r.category), r.id);
    if (r.type === "Spend" || r.type === "Refund") assert.ok(M.SPEND_CATS.includes(r.category), r.id);
    for (const s of r.categorySplits || []) assert.ok(M.SPEND_CATS.includes(s.category), r.id + " split " + s.category);
    for (const k of ["source", "sourceSplits", "bill", "billSplits"]) assert.equal(r[k], undefined, r.id + " " + k);
  }
  const before = real.transactions.filter(r => r.category === "Savings" || r.category === "Credit").map(r => r.id);
  const after = conv.transactions.filter(r => r.type === "Transfer").map(r => r.id);
  assert.deepEqual(after, before, "exactly the Savings and Credit rows became transfers");
  const savIn = real.income.filter(r => r.source === "Savings").map(r => r.id);
  assert.deepEqual(conv.income.filter(r => r.type === "Transfer").map(r => r.id), savIn);
  const cardIn = conv.income.filter(r => r.card === "Credit");
  assert.ok(cardIn.every(r => r.type === "Refund"), "card money-in rows are refunds");
});
