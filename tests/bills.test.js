"use strict";
// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/js/model.js");
const P = require("../public/js/periods.js");

const C = P.DEFAULT_CYCLE;
const per = iso => P.periodFor(C, iso);
const P1 = per("2026-10-16");                       // 16 Oct – 12 Nov 2026
const monthly = (from, amount, dueDay, account = "Flex") => ({ from, amount, freq: "monthly", dueDay, account });
const START = "2026-09-18";

function bills() {
  return [
    { id: "rent", name: "Rent", match: "joel kendall", versions: [monthly(START, 675, 1)] },
    { id: "ct", name: "Council Tax", match: "joel kendall", versions: [monthly(START, 61, 1)] },
    { id: "phone", name: "Phone", match: "vodafone", versions: [monthly(START, 11.41, 29)] },
    { id: "claude", name: "Claude", match: "claude", versions: [monthly(START, 18, 20, "Card")] },
    { id: "water", name: "Water", match: "southern water", versions: [{ from: START, amount: 180, freq: "yearly", dueDate: "03-15", account: "Flex" }] },
    { id: "card", name: "Credit card", match: "member credit card", reminder: true, versions: [monthly(START, 0, 5)] },
  ];
}
const tx = (id, date, name, amount, card = "Debit") => ({ id, date, name, amount, card, type: "Spend", category: "Bills" });
const ROWS = [
  tx("t1", "2026-10-31", "JOEL KENDALL", 675),
  tx("t2", "2026-11-01", "JOEL KENDALL", 61),
  tx("t3", "2026-10-20", "CLAUDE.AI SUBSCRIPTION", 18, "Credit"),
  tx("t4", "2026-10-20", "CLAUDE.AI", 18, "Debit"),
  { id: "t5", date: "2026-11-05", name: "MEMBER CREDIT CARD", amount: 300, card: "Debit", type: "Transfer", to: "Card" },
];
const mkDoc = (b = bills(), rows = ROWS) => ({ meta: { startDate: START }, payCycle: C, recurringBills: b, transactions: rows, income: [] });
const view = (doc, period, today) => M.periodBills(doc, period, today);
const item = (v, id, slot) => v.items.find(i => i.bill.id === id && (!slot || i.slot === slot));

/* ---------------- what's due in a period ---------------- */
test("a period lists the bills due in it by date, and the rest as not due", () => {
  const v = view(mkDoc(), P1, "2026-11-06");
  assert.deepEqual(v.items.map(i => [i.bill.id, i.date]),
    [["claude", "2026-10-20"], ["phone", "2026-10-29"], ["ct", "2026-11-01"], ["rent", "2026-11-01"], ["card", "2026-11-05"]]);
  assert.deepEqual(v.notDue.map(b => b.id), ["water"]);
  assert.equal(item(v, "rent").slot, "2026-11");
});

test("yearly bills fall in the period holding their date; rent on the 1st skips 2–29 Apr 2027", () => {
  const doc = mkDoc();
  const mar = view(doc, per("2027-03-15"), "2027-03-01");
  assert.deepEqual(item(mar, "water") && [item(mar, "water").date, item(mar, "water").slot], ["2027-03-15", "2027"]);
  const apr = view(doc, per("2027-04-02"), "2027-04-02");
  assert.equal(P.label(per("2027-04-02")), "2 Apr – 29 Apr");
  assert.ok(apr.notDue.some(b => b.id === "rent"));
  assert.ok(!item(apr, "rent"));
});

/* ---------------- statuses ---------------- */
test("statuses: upcoming, due (today or yesterday), overdue two days after", () => {
  const doc = mkDoc(bills(), []);
  const at = today => item(view(doc, P1, today), "phone");
  assert.deepEqual([at("2026-10-26").status, at("2026-10-26").daysUntil], ["upcoming", 3]);
  assert.equal(at("2026-10-29").status, "due");
  assert.equal(at("2026-10-30").status, "due");
  assert.equal(at("2026-10-31").status, "overdue");
});

test("a payment is matched on text, account and ±5 days, and the bill shows paid", () => {
  const v = view(mkDoc(), P1, "2026-11-06");
  const c = item(v, "claude");
  assert.deepEqual([c.status, c.how, c.payments.map(r => r.id), c.paidAmount, c.diff], ["paid", "auto", ["t3"], 18, 0], "the Flex row t4 is ignored");
  const late = d => item(view(mkDoc(bills(), [tx("x", d, "VODAFONE LTD", 12)]), P1, "2026-11-10"), "phone");
  assert.equal(late("2026-11-03").status, "paid", "5 days after");
  assert.equal(late("2026-11-04").status, "overdue", "6 days after is too far");
  assert.equal(late("2026-10-24").status, "paid", "5 days early");
  assert.equal(late("2026-11-03").diff, 0.59, "paid a little more than expected");
});

test("two bills with the same match text: closest amount wins before closest date", () => {
  const v = view(mkDoc(), P1, "2026-11-06");
  assert.deepEqual([item(v, "rent").payments[0].id, item(v, "ct").payments[0].id], ["t1", "t2"]);
  const swapped = mkDoc(bills(), [tx("a", "2026-11-01", "JOEL KENDALL", 61), tx("b", "2026-11-04", "JOEL KENDALL", 675)]);
  const w = view(swapped, P1, "2026-11-06");
  assert.deepEqual([item(w, "rent").payments[0].id, item(w, "ct").payments[0].id], ["b", "a"]);
});

/* ---------------- overrides ---------------- */
test("a manual link beats the automatic match, and that payment isn't matched to anything else", () => {
  const b = bills();
  M.overrideBill(b[0], "2026-11", { links: ["t2"] });                    // rent ← the £61 row
  const v = view(mkDoc(b), P1, "2026-11-06");
  const rent = item(v, "rent"), ct = item(v, "ct");
  assert.deepEqual([rent.status, rent.how, rent.payments.map(r => r.id), rent.edited], ["paid", "linked", ["t2"], true]);
  assert.deepEqual(ct.payments.map(r => r.id), ["t1"], "council tax can't have t2, so it takes the only other match");
});

test("unlinking a wrong match leaves the bill unpaid", () => {
  const b = bills();
  M.overrideBill(b[2], "2026-10", { links: [] });
  const doc = mkDoc(b, [tx("v", "2026-10-29", "VODAFONE", 11.41)]);
  assert.deepEqual([item(view(doc, P1, "2026-11-06"), "phone").status, item(view(doc, P1, "2026-11-06"), "phone").payments], ["overdue", []]);
});

test("skip, paid by hand and a one-off amount", () => {
  const b = bills();
  M.overrideBill(b[2], "2026-10", { skip: true });
  M.overrideBill(b[0], "2026-11", { paid: { date: "2026-11-01", amount: 600 } });
  M.overrideBill(b[1], "2026-11", { amount: 70 });
  const v = view(mkDoc(b), P1, "2026-11-06");
  assert.equal(item(v, "phone").status, "skipped");
  const rent = item(v, "rent");
  assert.deepEqual([rent.status, rent.how, rent.paidAmount, rent.paidDate, rent.diff, rent.payments], ["paid", "manual", 600, "2026-11-01", -75, []]);
  const ct = item(v, "ct");
  assert.deepEqual([ct.expected, ct.edited, ct.payments.map(r => r.id)], [70, true, ["t2"]], "nearest amount to the one-off £70");
  // clearing every one-off removes the override
  M.overrideBill(b[1], "2026-11", { amount: null });
  assert.equal(b[1].overrides["2026-11"], undefined);
});

test("a one-off date moves that occurrence (and its matching window), even into the next period", () => {
  const b = bills();
  M.overrideBill(b[0], "2026-11", { date: "2026-11-13" });
  const rows = [tx("late", "2026-11-14", "JOEL KENDALL", 675)];
  const doc = mkDoc(b, rows);
  const v1 = view(doc, P1, "2026-11-20");
  assert.ok(!item(v1, "rent"));
  assert.ok(v1.notDue.some(x => x.id === "rent"));
  const v2 = view(doc, per("2026-11-13"), "2026-11-20");
  assert.deepEqual(v2.items.filter(i => i.bill.id === "rent").map(i => [i.slot, i.date, i.status]),
    [["2026-11", "2026-11-13", "paid"], ["2026-12", "2026-12-01", "upcoming"]]);
  // a date more than a month away is ignored
  M.overrideBill(b[0], "2026-11", { date: "2027-01-20" });
  assert.equal(item(view(mkDoc(b, []), P1, "2026-10-20"), "rent").date, "2026-11-01");
});

test("one payment can be linked to several bills; the period total counts it once", () => {
  const b = bills();
  M.overrideBill(b[0], "2026-11", { links: ["lump"] });
  M.overrideBill(b[1], "2026-11", { links: ["lump"] });
  const doc = mkDoc(b, [tx("lump", "2026-11-01", "JOEL KENDALL", 736)]);
  const v = view(doc, P1, "2026-11-06");
  assert.deepEqual([item(v, "rent").status, item(v, "ct").status], ["paid", "paid"]);
  assert.deepEqual([item(v, "rent").shared, item(v, "rent").diff], [true, null], "no 'paid more than usual' note for a shared payment");
  assert.equal(v.totals.paid, 736);
});

test("the card repayment reminder has a status but stays out of the totals", () => {
  const v = view(mkDoc(), P1, "2026-11-06");
  const card = item(v, "card");
  assert.deepEqual([card.reminder, card.status, card.payments.map(r => r.id), card.diff], [true, "paid", ["t5"], null]);
  assert.deepEqual(v.totals, { due: 765.41, paid: 754, toPay: 11.41, smoothed: 720.38 });
  assert.deepEqual([...M.billPaymentIds(M.billTimeline(mkDoc(), "2026-12-31"))].sort(), ["t1", "t2", "t3"]);
});

/* ---------------- changing a bill ---------------- */
test("a change applies from its period on; earlier periods keep what they were", () => {
  const b = bills();
  M.changeBillFrom(b[0], "2027-01-08", { amount: 700 });
  const doc = mkDoc(b, []);
  assert.equal(item(view(doc, per("2027-01-01"), "2026-12-15"), "rent").expected, 675, "1 Jan is in 11 Dec – 7 Jan");
  assert.equal(item(view(doc, per("2027-02-01"), "2026-12-15"), "rent").expected, 700);
  // an earlier change of due day also reaches the later version, which keeps its amount
  M.changeBillFrom(b[0], "2026-11-13", { dueDay: 2 });
  assert.deepEqual(b[0].versions.map(v => [v.from, v.amount, v.dueDay]), [[START, 675, 1], ["2026-11-13", 675, 2], ["2027-01-08", 700, 2]]);
  assert.equal(item(view(doc, P1, "2026-10-20"), "rent").date, "2026-11-01");
  assert.equal(item(view(doc, per("2026-12-02"), "2026-10-20"), "rent").date, "2026-12-02");
  assert.equal(item(view(doc, per("2027-02-02"), "2026-10-20"), "rent").date, "2027-02-02");
});

test("moving the due day can give a month two occurrences, each with its own slot", () => {
  const b = bills();
  b[2].versions = [monthly(START, 11.41, 10)];
  M.changeBillFrom(b[2], "2026-10-16", { dueDay: 25 });
  M.overrideBill(b[2], "2026-10#2", { skip: true });
  const doc = mkDoc(b, []);
  const oct = M.billTimeline(doc, "2026-11-30").filter(o => o.bill.id === "phone").map(o => [o.slot, o.date, !!o.override.skip]);
  assert.deepEqual(oct, [["2026-09", "2026-09-10", false], ["2026-10", "2026-10-10", false], ["2026-10#2", "2026-10-25", true], ["2026-11", "2026-11-25", false]].filter(x => x[1] >= START));
});

test("an ended bill stops; restarting it later copies its last amount", () => {
  const b = bills();
  M.endBillFrom(b[2], "2027-01-08");
  const doc = mkDoc(b, []);
  assert.ok(item(view(doc, per("2026-12-29"), "2026-12-01"), "phone"), "still due 29 Dec");
  const jan = view(doc, per("2027-01-29"), "2026-12-01");
  assert.ok(!item(jan, "phone") && !jan.notDue.some(x => x.id === "phone"));
  M.changeBillFrom(b[2], "2027-03-05", { dueDay: 15 });
  assert.deepEqual(b[2].versions.slice(-1)[0], { from: "2027-03-05", amount: 11.41, freq: "monthly", dueDay: 15, account: "Flex" });
  assert.equal(item(view(doc, per("2027-03-15"), "2026-12-01"), "phone").expected, 11.41);
});

test("switching a bill to yearly clears its due day", () => {
  const b = bills();
  M.changeBillFrom(b[2], "2026-10-16", { freq: "yearly", dueDate: "11-01", dueDay: null, amount: 120 });
  const v = b[2].versions.slice(-1)[0];
  assert.deepEqual(v, { from: "2026-10-16", amount: 120, freq: "yearly", account: "Flex", dueDate: "11-01" });
  assert.deepEqual(item(view(mkDoc(b, []), P1, "2026-10-20"), "phone").slot, "2026");
});

test("billProblems: the bill editor's checks", () => {
  const ok = { name: "Phone", amount: 11.41, freq: "monthly", dueDay: 21, account: "Flex" };
  assert.deepEqual(M.billProblems(ok), []);
  assert.deepEqual(M.billProblems({ ...ok, freq: "yearly", dueDay: null, dueDate: "03-15", account: "Card" }), []);
  assert.equal(M.billProblems({ ...ok, name: " " })[0], "A bill has no name.");
  assert.match(M.billProblems({ ...ok, amount: "" })[0], /amount/);
  assert.match(M.billProblems({ ...ok, amount: -1 })[0], /amount/);
  assert.match(M.billProblems({ ...ok, dueDay: 32 })[0], /due day/);
  assert.match(M.billProblems({ ...ok, freq: "yearly", dueDate: "02-30" })[0], /due date/);
  assert.match(M.billProblems({ ...ok, freq: "weekly" })[0], /monthly or yearly/);
  assert.match(M.billProblems({ ...ok, account: "Savings" })[0], /Flex or the card/);
});
