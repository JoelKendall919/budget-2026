"use strict";
/* =========================================================================
   Budget model — row types, accounts, bills and pay-period budgets.

   Pure functions over the budget document: no DOM and no globals, so every
   rule here can be unit-tested in Node (see tests/model.test.js).

   Rows
     doc.transactions = money out, doc.income = money in ("dir" out / in).
     Each row is on one account: card "Debit" = Flex, card "Credit" = Card.
     Rows saved since the restart carry a `type`:
       Spend    (out) counts against its category
       Refund   (in)  takes money off its category
       Income   (in)  Salary / Gifts received / Other income
       Transfer (out or in) your own money moving; `to` (out) or `from` (in)
                names the far side: "Card", "Flex" or "Savings"
     Older rows have no type and are read the way the app always read them
     (see classify), so balances never change because of the new types.

   Loaded in the browser as window.Model (after periods.js); required by
   Node for tests.
   ========================================================================= */
(function (root, factory) {
  const P = root && root.Periods ? root.Periods : (typeof require === "function" ? require("./periods.js") : null);
  const api = factory(P);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== "undefined" ? self : this, function (P) {

  /* ======================= names ======================= */
  const TYPES = ["Spend", "Refund", "Income", "Transfer"];
  const SPEND_CATS = ["Bills", "Groceries", "Pub & Social", "Eating out", "Transport",
    "Shopping", "Health & Personal", "Home", "Gifts", "Other"];
  const INCOME_CATS = ["Salary", "Gifts received", "Other income"];
  const TRANSFER_ACCOUNTS = ["Card", "Flex", "Savings"];
  // spending categories before the restart → after
  const OLD_SPEND = {
    "Bills": "Bills", "Groceries": "Groceries", "Pub/Social": "Pub & Social",
    "Takeaway/Restaurant": "Eating out", "Travel/Car": "Transport", "Gifts": "Gifts", "Other": "Other",
  };
  // money-in sources before the restart that were real income
  const OLD_INCOME = { "Salary": "Salary", "Presents": "Gifts received", "Gifts": "Gifts received" };

  const accountOf = row => (row && row.card === "Credit" ? "Card" : "Flex");
  const isRestarted = doc => !!(doc && doc.meta && doc.meta.startDate);
  const round2 = n => Math.round((+n || 0) * 100) / 100;

  // Spending categories the document uses ("Savings" was a category before
  // the restart but was really a transfer).
  const spendCats = doc => ((doc && doc.categories) || []).filter(c => c !== "Savings" && c !== "Credit");
  const incomeCats = doc => (doc && doc.incomeCategories && doc.incomeCategories.length ? doc.incomeCategories : INCOME_CATS);

  /* ======================= what a row is ======================= */
  // Returns {type, category, other}. `categories` is the document's category
  // list, needed only for rows saved before types existed:
  //   money out  "Savings" → transfer to savings; a category that isn't in
  //              the list (i.e. "Credit") → card repayment; else spend
  //   money in   Salary / Presents / Gifts → income; Savings → transfer from
  //              savings; a spending category (incl. Other) → refund, which
  //              is how the old dashboard netted them off; else income
  function classify(row, dir, categories) {
    if (row.type) {
      if (row.type === "Transfer") return { type: "Transfer", category: null, other: (dir === "in" ? row.from : row.to) || row.to || row.from || null };
      return { type: row.type, category: row.category || null, other: null };
    }
    const cats = categories || [];
    if (dir === "out") {
      if (row.category === "Savings") return { type: "Transfer", category: null, other: "Savings" };
      if (!cats.includes(row.category)) return { type: "Transfer", category: null, other: "Card" };
      return { type: "Spend", category: row.category, other: null };
    }
    const src = row.source;
    if (src === "Savings") return { type: "Transfer", category: null, other: "Savings" };
    if (OLD_INCOME[src]) return { type: "Income", category: src, other: null };
    if (src === "Reimbursement" || src === "Refund") return { type: "Refund", category: "Other", other: null };
    if (src && cats.includes(src)) return { type: "Refund", category: src, other: null };
    return { type: "Income", category: src || "Other income", other: null };
  }

  // How a row moves the two tracked accounts. Savings and cash balances are
  // typed in on the Accounts tab, so a transfer to savings only moves Flex.
  function effects(row, dir, categories) {
    const amt = +row.amount || 0, own = accountOf(row), sign = dir === "out" ? -1 : 1;
    const e = { Flex: 0, Card: 0 };
    e[own] += sign * amt;
    const c = classify(row, dir, categories);
    if (c.type === "Transfer" && (c.other === "Flex" || c.other === "Card") && c.other !== own) e[c.other] -= sign * amt;
    return e;
  }

  // Every row in date order (money in before money out on the same day) with
  // its effect on each account and the running balances after it.
  function ledger(doc) {
    const cats = doc.categories || [];
    const rows = [];
    (doc.transactions || []).forEach((row, i) => rows.push({ row, dir: "out", i }));
    (doc.income || []).forEach((row, i) => rows.push({ row, dir: "in", i }));
    rows.sort((a, b) => a.row.date.localeCompare(b.row.date) || (a.dir === b.dir ? a.i - b.i : a.dir === "in" ? -1 : 1));
    const acc = doc.accounts || {};
    let flex = +acc.openingFlex || 0, card = +acc.openingCredit || 0;
    rows.forEach(r => {
      const e = effects(r.row, r.dir, cats);
      r.flex = e.Flex; r.card = e.Card;
      r.affectsFlex = e.Flex !== 0 || accountOf(r.row) === "Flex";
      r.affectsCard = e.Card !== 0 || accountOf(r.row) === "Card";
      if (r.affectsFlex) { flex = round2(flex + e.Flex); r.flexBal = flex; }
      if (r.affectsCard) { card = round2(card + e.Card); r.cardBal = card; }
    });
    return rows;
  }

  // Balances at the close of `uptoIso` (or including everything).
  // Card is negative when you owe money on it.
  function balances(doc, uptoIso) {
    const cats = doc.categories || [];
    const acc = doc.accounts || {};
    let flex = +acc.openingFlex || 0, card = +acc.openingCredit || 0;
    const add = dir => row => {
      if (uptoIso && row.date > uptoIso) return;
      const e = effects(row, dir, cats);
      flex += e.Flex; card += e.Card;
    };
    (doc.transactions || []).forEach(add("out"));
    (doc.income || []).forEach(add("in"));
    return { flex: round2(flex), card: round2(card) };
  }

  /* ======================= rules ======================= */
  // A rule is {match, category} or {match, transfer: "Savings" | "Card" | "Flex"}.
  // Matches are lower-case and the longest match wins.
  function normaliseRules(rules) {
    const seen = new Set(), out = [];
    (rules || []).forEach(r => {
      const match = String((r && r.match) || "").trim().toLowerCase();
      if (!match || seen.has(match)) return;
      seen.add(match);
      if (r.transfer) out.push({ match, transfer: r.transfer });
      else out.push({ match, category: r.category || "Other" });
    });
    return out.sort((a, b) => b.match.length - a.match.length);
  }
  function ruleFor(rules, text) {
    const d = String(text || "").toLowerCase();
    return (rules || []).find(r => r.match && d.includes(r.match)) || null;
  }
  // What a rule makes of a row in a given direction: {type, category, other}.
  function fromRule(rule, dir, doc) {
    if (!rule) return null;
    if (rule.transfer) return { type: "Transfer", category: null, other: rule.transfer };
    if (incomeCats(doc).includes(rule.category))
      return dir === "in" ? { type: "Income", category: rule.category, other: null } : { type: "Spend", category: "Other", other: null };
    return { type: dir === "in" ? "Refund" : "Spend", category: rule.category, other: null };
  }
  // Write a classification onto a row (type + category, or type + to/from).
  function setKind(row, dir, kind) {
    row.type = kind.type;
    delete row.source; delete row.sourceSplits; delete row.to; delete row.from;
    if (kind.type === "Transfer") { row[dir === "in" ? "from" : "to"] = kind.other; delete row.category; delete row.categorySplits; }
    else row.category = kind.category;
    return row;
  }

  /* ======================= converting old rows ======================= */
  const newSpendCat = c => (SPEND_CATS.includes(c) ? c : (OLD_SPEND[c] || "Other"));
  const newIncomeCat = c => (INCOME_CATS.includes(c) ? c : (OLD_INCOME[c] || "Other income"));

  const REPLACED = ["type", "category", "categorySplits", "source", "sourceSplits", "to", "from", "bill", "billSplits"];
  // An old row in the new shape: a type, a new category (or transfer account),
  // no bill assignments; any other fields are kept. `oldCategories` is the
  // category list it was saved with.
  function convertRow(row, dir, oldCategories) {
    const c = classify(row, dir, oldCategories);
    const out = {};
    Object.keys(row).forEach(k => { if (!REPLACED.includes(k)) out[k] = row[k]; });
    out.card = row.card || "Debit";
    out.type = c.type;
    if (c.type === "Transfer") out[dir === "in" ? "from" : "to"] = c.other;
    else if (c.type === "Income") out.category = newIncomeCat(c.category);
    else {
      out.category = newSpendCat(c.category);
      const splits = !row.type && dir === "in"
        ? (row.sourceSplits || []).map(s => ({ category: s.source, amount: s.amount }))
        : (row.categorySplits || []);
      if (splits.length) out.categorySplits = splits.map(s => ({ category: newSpendCat(s.category), amount: s.amount }));
    }
    return out;
  }
  // Old rows whose meaning isn't clear from their category need a person to
  // say what they really were: spending in "Other", and money in that wasn't
  // salary, a present, from savings or paying back a named category.
  function needsReview(row, dir) {
    if (row.type) return false;
    if (dir === "out") return row.category === "Other";
    const s = row.source;
    return !(s === "Savings" || OLD_INCOME[s] || (OLD_SPEND[s] && s !== "Other"));
  }

  /* ======================= bills ======================= */
  // doc.recurringBills — each bill:
  //   {id, name, match, notes, reminder, versions, overrides}
  //   match      text to find in the statement description (defaults to the name)
  //   reminder   true for the card repayment: it gets a status like any bill
  //              but is a transfer, so it is never added to the totals
  //   versions   oldest first; each applies to due dates from its period on:
  //              {from: periodKey, amount, freq: "monthly"|"yearly",
  //               dueDay: 1-31 (monthly) | dueDate: "MM-DD" (yearly),
  //               account: "Flex"|"Card"}   or {from, off: true} once ended
  //   overrides  one occurrence each, keyed by its slot — "2026-10" (monthly)
  //              or "2027" (yearly), so a one-off survives a due-day change:
  //              {skip, amount, date, links: [transaction ids], paid: {date, amount}}
  const MATCH_DAYS = 5, OVERDUE_DAYS = 2, DATE_MOVE_DAYS = 31, AHEAD_DAYS = 62;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  const cycleOf = doc => (doc && doc.payCycle) || P.DEFAULT_CYCLE;
  const startOf = doc => (doc && doc.meta && doc.meta.startDate) || P.normCycle(cycleOf(doc)).anchor;
  const maxIso = (a, b) => (a > b ? a : b);
  const sortedVersions = bill => (bill.versions || []).slice().sort((a, b) => a.from.localeCompare(b.from));
  const matchTextOf = bill => String(bill.match || bill.name || "").trim().toLowerCase();
  const hasOverride = ov => !!ov && Object.keys(ov).some(k => ov[k] != null);
  const num = v => (v == null || v === "" || !isFinite(+v) ? null : +v);

  // The version in force for a period, or null if the bill hasn't started or has ended.
  function billVersion(bill, key) {
    let v = null;
    for (const x of sortedVersions(bill)) if (x.from <= key) v = x;
    return v && !v.off ? v : null;
  }

  // Every occurrence of one bill whose (possibly moved) date is in [fromIso, toIso].
  // Slots are numbered over whole years, so they don't depend on the window.
  function billOccurrences(bill, cycle, fromIso, toIso) {
    const versions = sortedVersions(bill), cands = [];
    const lo = P.addDays(fromIso, -40).slice(0, 4) + "-01-01", hi = P.addDays(toIso, 40).slice(0, 4) + "-12-31";
    versions.forEach(v => {
      if (v.off) return;
      const sched = v.freq === "yearly" ? { dueDate: v.dueDate } : { dueDay: v.dueDay };
      P.occurrences(sched, lo, hi).forEach(d => {
        if (billVersion(bill, P.periodFor(cycle, d).key) === v) cands.push({ scheduled: d, version: v });
      });
    });
    cands.sort((a, b) => a.scheduled.localeCompare(b.scheduled));
    const seen = {}, out = [];
    cands.forEach(c => {
      const base = c.version.freq === "yearly" ? c.scheduled.slice(0, 4) : c.scheduled.slice(0, 7);
      seen[base] = (seen[base] || 0) + 1;
      const slot = seen[base] === 1 ? base : base + "#" + seen[base];
      const override = (bill.overrides || {})[slot] || {};
      const moved = ISO_RE.test(override.date || "") && Math.abs(P.diffDays(c.scheduled, override.date)) <= DATE_MOVE_DAYS;
      const date = moved ? override.date : c.scheduled;
      if (date >= fromIso && date <= toIso) out.push({ bill, slot, scheduled: c.scheduled, date, version: c.version, override });
    });
    return out;
  }

  // Decide which payments paid which occurrence (sets o.payments and o.how).
  // Manual choices win: a skipped or paid-by-hand occurrence takes no
  // payment, `links` (even an empty list) replaces the automatic match, and
  // a payment linked by hand is never matched to anything else. Otherwise a
  // payment matches when it is on the bill's account, its description holds
  // the match text and it is within MATCH_DAYS of the due date. Each payment
  // pays one bill: closest amount first, then closest date.
  function matchBills(doc, occs) {
    const tx = doc.transactions || [];
    const byId = new Map(tx.map(r => [r.id, r]));
    const claimed = new Set();
    occs.forEach(o => (o.override.links || []).forEach(id => claimed.add(id)));
    const sorted = tx.map((r, i) => ({ r, i })).filter(x => x.r.date).sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i);
    const dates = sorted.map(x => x.r.date);
    const lowerBound = iso => { let a = 0, b = dates.length; while (a < b) { const m = (a + b) >> 1; if (dates[m] < iso) a = m + 1; else b = m; } return a; };
    const pairs = [];
    occs.forEach((o, oi) => {
      const ov = o.override;
      o.payments = []; o.how = null;
      if (ov.skip) return;
      if (ov.paid) { o.how = "manual"; return; }
      if (ov.links) { o.payments = ov.links.map(id => byId.get(id)).filter(Boolean); o.how = o.payments.length ? "linked" : null; return; }
      const text = matchTextOf(o.bill), account = o.version.account || "Flex", expected = expectedOf(o);
      if (!text) return;
      const last = P.addDays(o.date, MATCH_DAYS);
      for (let k = lowerBound(P.addDays(o.date, -MATCH_DAYS)); k < sorted.length && sorted[k].r.date <= last; k++) {
        const { r, i } = sorted[k];
        if (claimed.has(r.id) || accountOf(r) !== account || !String(r.name || "").toLowerCase().includes(text)) continue;
        pairs.push({ oi, i, r, amt: Math.abs(round2((+r.amount || 0) - expected)), days: Math.abs(P.diffDays(o.date, r.date)) });
      }
    });
    pairs.sort((a, b) => a.amt - b.amt || a.days - b.days || occs[a.oi].date.localeCompare(occs[b.oi].date) || a.oi - b.oi || a.i - b.i);
    const usedRow = new Set(), doneOcc = new Set();
    pairs.forEach(p => {
      if (usedRow.has(p.i) || doneOcc.has(p.oi)) return;
      usedRow.add(p.i); doneOcc.add(p.oi);
      occs[p.oi].payments = [p.r]; occs[p.oi].how = "auto";
    });
    const uses = new Map();
    occs.forEach(o => o.payments.forEach(r => uses.set(r.id, (uses.get(r.id) || 0) + 1)));
    occs.forEach(o => { o.shared = o.payments.some(r => uses.get(r.id) > 1); });
    return occs;
  }
  function expectedOf(o) {
    const a = num(o.override.amount);
    return a != null ? a : (+o.version.amount || 0);
  }

  // Every occurrence of every bill from the budget's start to `untilIso`,
  // with its payments. Work this out once per screen and pass it around;
  // `untilIso` should be well past today so nothing near today is cut off.
  function billTimeline(doc, untilIso) {
    const cycle = cycleOf(doc), from = startOf(doc), occs = [];
    (doc.recurringBills || []).forEach(b => occs.push(...billOccurrences(b, cycle, from, untilIso)));
    occs.sort((a, b) => a.date.localeCompare(b.date) || String(a.bill.name).localeCompare(String(b.bill.name)));
    return matchBills(doc, occs);
  }
  const timelineFor = (doc, period, today) => billTimeline(doc, P.addDays(maxIso(period.end, today), AHEAD_DAYS));

  // paid · skipped · upcoming (not due yet) · due (today or yesterday,
  // probably still clearing) · overdue (OVERDUE_DAYS after the due date)
  function billStatus(o, today) {
    if (o.override.skip) return "skipped";
    if (o.how === "manual" || o.payments.length) return "paid";
    const late = P.diffDays(o.date, today);
    return late < 0 ? "upcoming" : late < OVERDUE_DAYS ? "due" : "overdue";
  }
  function describeBill(o, today) {
    const status = billStatus(o, today), expected = expectedOf(o), ov = o.override;
    let paidAmount = null, paidDate = null;
    if (status === "paid") {
      if (o.how === "manual") { paidAmount = num(ov.paid.amount) != null ? +ov.paid.amount : expected; paidDate = ov.paid.date || o.date; }
      else { paidAmount = round2(o.payments.reduce((s, r) => s + (+r.amount || 0), 0)); paidDate = o.payments[0].date; }
    }
    return {
      bill: o.bill, slot: o.slot, version: o.version, scheduled: o.scheduled, date: o.date,
      expected, status, how: o.how, payments: o.payments, paidAmount, paidDate, shared: !!o.shared,
      // a payment shared between bills can't be compared with one bill's
      // amount, and a reminder's amount is only a guide
      diff: paidAmount == null || o.shared || o.bill.reminder ? null : round2(paidAmount - expected),
      daysUntil: P.diffDays(today, o.date), edited: hasOverride(ov), reminder: !!o.bill.reminder,
    };
  }

  // What the Bills tab shows for one period: each due bill with its status,
  // the bills in force that aren't due this period, and the totals (the
  // card-repayment reminder and skipped bills are left out of the totals).
  function periodBills(doc, period, today, timeline) {
    const tl = timeline || timelineFor(doc, period, today);
    const items = tl.filter(o => o.date >= period.start && o.date <= period.end).map(o => describeBill(o, today));
    const dueIds = new Set(items.map(i => i.bill.id));
    const notDue = (doc.recurringBills || []).filter(b => !dueIds.has(b.id) && billVersion(b, period.key));
    const counted = items.filter(i => !i.reminder && i.status !== "skipped");
    const seenRows = new Set();
    let due = 0, paid = 0, toPay = 0;
    counted.forEach(i => {
      due += i.expected;
      if (i.status !== "paid") { toPay += i.expected; return; }
      if (i.how === "manual") { paid += i.paidAmount; return; }
      i.payments.forEach(r => { if (!seenRows.has(r.id)) { seenRows.add(r.id); paid += +r.amount || 0; } });
    });
    const days = P.normCycle(cycleOf(doc)).days;
    const smoothed = (doc.recurringBills || []).reduce((s, b) => {
      const v = !b.reminder && billVersion(b, period.key);
      return v ? s + P.smoothedPerPeriod(v.amount, v.freq, days) : s;
    }, 0);
    return { items, notDue, totals: { due: round2(due), paid: round2(paid), toPay: round2(toPay), smoothed: round2(smoothed) } };
  }

  // Ids of payments that paid a bill (not the card reminder); those rows count as Bills.
  function billPaymentIds(timeline) {
    const ids = new Set();
    timeline.forEach(o => { if (!o.bill.reminder && !o.override.skip) o.payments.forEach(r => ids.add(r.id)); });
    return ids;
  }

  /* ---- changing bills (these edit the bill passed in) ---- */
  const VERSION_FIELDS = ["amount", "freq", "dueDay", "dueDate", "account"];
  // Change a bill from a period onwards; earlier periods keep what they were,
  // and the changed fields are also set on any later versions.
  function changeBillFrom(bill, key, changes) {
    const fields = VERSION_FIELDS.filter(f => f in changes);
    const versions = sortedVersions(bill);
    let v = versions.find(x => x.from === key);
    if (!v || v.off) {
      const base = versions.filter(x => x.from < key && !x.off).pop() || {};
      if (!v) { v = { from: key }; versions.push(v); }
      delete v.off;
      VERSION_FIELDS.forEach(f => { if (base[f] != null) v[f] = base[f]; });
    }
    versions.forEach(x => {
      if (x.from < key || x.off) return;
      fields.forEach(f => { if (changes[f] == null) delete x[f]; else x[f] = changes[f]; });
    });
    bill.versions = versions.sort((a, b) => a.from.localeCompare(b.from));
    return bill;
  }
  // Stop a bill from a period onwards (later versions go too).
  function endBillFrom(bill, key) {
    bill.versions = sortedVersions(bill).filter(x => x.from < key).concat([{ from: key, off: true }]);
    return bill;
  }
  // One-off changes to one occurrence; null clears a field, and an empty
  // override is removed.
  function overrideBill(bill, slot, changes) {
    const ov = Object.assign({}, (bill.overrides || {})[slot], changes);
    Object.keys(ov).forEach(k => { if (ov[k] == null) delete ov[k]; });
    bill.overrides = Object.assign({}, bill.overrides);
    if (Object.keys(ov).length) bill.overrides[slot] = ov; else delete bill.overrides[slot];
    return bill;
  }

  /* ======================= pay-period budget ======================= */
  // doc.budget:
  //   standard  [{from: periodKey, cats: {category: amount}, savings}], oldest
  //             first; each applies from its period on ("this and future")
  //   periods   {periodKey: {cats: {category: amount}, savings, pay}} —
  //             "this period only" changes, and a pay figure typed by hand
  const byFrom = (a, b) => a.from.localeCompare(b.from);

  // The period a row is budgeted in: its "count in" period, or its date's.
  function rowPeriodKey(doc, row) {
    const cycle = cycleOf(doc);
    if (row.countIn && P.periodByKey(cycle, row.countIn)) return row.countIn;
    return ISO_RE.test(row.date || "") ? P.periodFor(cycle, row.date).key : null;
  }
  function inPeriod(cycle, period, row) {
    if (row.countIn && P.periodByKey(cycle, row.countIn)) return row.countIn === period.key;
    return row.date >= period.start && row.date <= period.end;
  }

  function standardAt(doc, key) {
    let v = null;
    ((doc.budget && doc.budget.standard) || []).slice().sort(byFrom).forEach(x => { if (x.from <= key) v = x; });
    return v || { from: null, cats: {}, savings: 0 };
  }
  // A period's budget: the standard in force, with "this period only"
  // changes on top (edited: true).
  function budgetFor(doc, key) {
    const std = standardAt(doc, key), own = ((doc.budget && doc.budget.periods) || {})[key] || {};
    const sc = std.cats || {}, oc = own.cats || {}, cats = {};
    new Set([...Object.keys(sc), ...Object.keys(oc)]).forEach(c => {
      const s = num(sc[c]) || 0, o = num(oc[c]);
      cats[c] = { amount: o != null ? o : s, standard: s, edited: o != null };
    });
    const ss = num(std.savings) || 0, os = num(own.savings);
    return { cats, savings: { amount: os != null ? os : ss, standard: ss, edited: os != null }, pay: num(own.pay) };
  }

  // Set a category budget (category) or the savings target (category null)
  // for "period" (this period only) or "future" (this and future periods).
  function setBudget(doc, key, category, amount, scope) {
    const b = doc.budget = doc.budget || {};
    b.standard = b.standard || []; b.periods = b.periods || {};
    const value = num(amount) || 0;
    const put = x => { if (category == null) x.savings = value; else (x.cats = x.cats || {})[category] = value; };
    if (scope === "period") { put(b.periods[key] = b.periods[key] || {}); return doc; }
    if (!b.standard.some(x => x.from === key)) {
      const base = standardAt(doc, key);
      b.standard.push({ from: key, cats: Object.assign({}, base.cats), savings: num(base.savings) || 0 });
    }
    b.standard.sort(byFrom).forEach(x => { if (x.from >= key) put(x); });
    return resetBudget(doc, key, category);
  }
  // "Reset to standard": drop this period's own figure.
  function resetBudget(doc, key, category) {
    const periods = doc.budget && doc.budget.periods, own = periods && periods[key];
    if (!own) return doc;
    if (category == null) delete own.savings;
    else if (own.cats) { delete own.cats[category]; if (!Object.keys(own.cats).length) delete own.cats; }
    if (!Object.keys(own).length) delete periods[key];
    return doc;
  }
  // Pay typed by hand for one period (null goes back to automatic).
  function setPay(doc, key, amount) {
    const b = doc.budget = doc.budget || {};
    b.periods = b.periods || {};
    const v = num(amount);
    if (v != null) (b.periods[key] = b.periods[key] || {}).pay = v;
    else if (b.periods[key]) { delete b.periods[key].pay; if (!Object.keys(b.periods[key]).length) delete b.periods[key]; }
    return doc;
  }
  // Move one payday (key = its usual date); null or the usual date puts it
  // back. Returns false if the date is half a period or more away.
  function setPayday(doc, key, iso) {
    const c = P.normCycle(cycleOf(doc));
    if (!P.periodByKey(c, key)) return false;
    const overrides = Object.assign({}, c.overrides);
    if (!iso || iso === key) delete overrides[key];
    else if (!ISO_RE.test(iso) || Math.abs(P.diffDays(key, iso)) * 2 >= c.days) return false;
    else overrides[key] = iso;
    doc.payCycle = { anchor: c.anchor, days: c.days, overrides };
    return true;
  }

  // A row's amount by category: its splits, with anything not split counted
  // in the row's own category.
  function allocations(row, kind) {
    const amt = +row.amount || 0, own = kind.category || "Other";
    const splits = (row.categorySplits || []).filter(s => s && s.category);
    if (!splits.length) return [{ category: own, amount: amt }];
    const out = splits.map(s => ({ category: s.category, amount: +s.amount || 0 }));
    const rest = round2(amt - out.reduce((s, a) => s + a.amount, 0));
    if (rest) out.push({ category: own, amount: rest });
    return out;
  }
  // Money that counts in one period (its "count in" period, or its date's).
  //   spent        Spend − Refund per category
  //   income       Income per income category
  //   saved        transfers to savings − transfers back from savings
  //   billPayments payments that paid a bill (ids in `billIds`); they are
  //                left out of `spent`, because the Budget tab counts them
  //                in the period of the bill they paid (see periodBudget)
  // Card repayments and other transfers count nowhere.
  function periodFlows(doc, period, billIds) {
    const cycle = cycleOf(doc), cats = doc.categories || [];
    const spent = {}, income = {};
    let saved = 0, billPayments = 0;
    const add = (map, c, a) => { map[c] = round2((map[c] || 0) + a); };
    (doc.transactions || []).forEach(r => {
      if (!inPeriod(cycle, period, r)) return;
      const k = classify(r, "out", cats), amt = +r.amount || 0;
      if (k.type === "Transfer") { if (k.other === "Savings") saved += amt; return; }
      if (k.type !== "Spend") return;
      if (billIds && billIds.has(r.id)) billPayments += amt;
      else allocations(r, k).forEach(a => add(spent, a.category, a.amount));
    });
    (doc.income || []).forEach(r => {
      if (!inPeriod(cycle, period, r)) return;
      const k = classify(r, "in", cats), amt = +r.amount || 0;
      if (k.type === "Transfer") { if (k.other === "Savings") saved -= amt; return; }
      if (k.type === "Refund") allocations(r, k).forEach(a => add(spent, a.category, -a.amount));
      else if (k.type === "Income") add(income, k.category || "Other income", amt);
    });
    return { spent, income, saved: round2(saved), billPayments: round2(billPayments) };
  }

  // Pay for the summary: typed by hand › salary received in the period ›
  // for the current or a future period, the last pay received › 0.
  function payFor(doc, period, flows, today) {
    const received = flows.income.Salary || 0, typed = budgetFor(doc, period.key).pay;
    if (typed != null) return { amount: typed, source: "typed", received };
    if (received > 0) return { amount: received, source: "received", received };
    if (period.end < today) return { amount: 0, source: "none", received };
    const cats = doc.categories || [], byKey = {};
    (doc.income || []).forEach(r => {
      const k = classify(r, "in", cats);
      if (k.type !== "Income" || k.category !== "Salary") return;
      const key = rowPeriodKey(doc, r);
      if (key && key < period.key) byKey[key] = (byKey[key] || 0) + (+r.amount || 0);
    });
    const last = Object.keys(byKey).sort().pop();
    return last ? { amount: round2(byKey[last]), source: "last", received, from: last } : { amount: 0, source: "none", received };
  }

  // Everything the Budget tab shows for one period. The Bills row is the
  // Bills tab: budget = bills due this period, spent = what paid them (even
  // a day or two into the next period) plus any other spending in Bills.
  function periodBudget(doc, period, today, timeline) {
    const tl = timeline || timelineFor(doc, period, today);
    const bills = periodBills(doc, period, today, tl);
    const flows = periodFlows(doc, period, billPaymentIds(tl));
    const plan = budgetFor(doc, period.key);
    const known = spendCats(doc).filter(c => c !== "Bills");
    const extra = new Set();
    Object.keys(plan.cats).forEach(c => { if (plan.cats[c].amount) extra.add(c); });
    Object.keys(flows.spent).forEach(c => { if (flows.spent[c]) extra.add(c); });
    const names = known.concat([...extra].filter(c => c !== "Bills" && !known.includes(c)).sort());
    const billsSpent = round2(bills.totals.paid + (flows.spent.Bills || 0));
    const rows = [{ category: "Bills", budget: bills.totals.due, spent: billsSpent, fromBills: true, edited: false }]
      .concat(names.map(c => {
        const p = plan.cats[c] || { amount: 0, standard: 0, edited: false };
        return { category: c, budget: p.amount, standard: p.standard, edited: p.edited, spent: flows.spent[c] || 0 };
      }));
    rows.forEach(r => { r.left = round2(r.budget - r.spent); });
    const sum = f => round2(rows.reduce((s, r) => s + r[f], 0));
    const totals = { budget: sum("budget"), spent: sum("spent"), left: sum("left") };
    const budgets = round2(totals.budget - bills.totals.due);
    const pay = payFor(doc, period, flows, today);
    const savings = { target: plan.savings.amount, standard: plan.savings.standard, edited: plan.savings.edited, saved: flows.saved };
    const summary = {
      pay: pay.amount, billsDue: bills.totals.due, budgets, savings: savings.target,
      unallocated: round2(pay.amount - bills.totals.due - budgets - savings.target),
    };
    return { period, rows, totals, savings, pay, summary, bills, flows };
  }

  // The "Until payday" card. Safe to spend = Flex balance − what's owed on
  // the card − bills still to pay before payday (on either account: a card
  // bill will be added to what's owed when it's charged). The card
  // repayment is a transfer, so it changes nothing here.
  function untilPayday(doc, today, timeline) {
    const period = P.periodFor(cycleOf(doc), today);
    const bills = periodBills(doc, period, today, timeline || timelineFor(doc, period, today));
    const due = bills.items.filter(i => !i.reminder && i.status !== "paid" && i.status !== "skipped");
    const billsDue = round2(due.reduce((s, i) => s + i.expected, 0));
    const bal = balances(doc, today), cardOwed = bal.card < 0 ? -bal.card : 0;
    const safe = round2(bal.flex - cardOwed - billsDue), daysLeft = P.diffDays(today, period.next);
    return { period, daysLeft, flex: bal.flex, card: bal.card, cardOwed, billsDue, bills: due, safe, perDay: round2(safe / Math.max(1, daysLeft)) };
  }

  /* ======================= restart ======================= */
  // One-off: start the budget again from a payday (docs/plans/
  // pay-period-budgeting.md 3.6). Rows from that day on are kept and
  // converted to types and the new categories; the old monthly budgets,
  // bill lists and earlier rows stay only in the archive (the old document,
  // saved as is). Nothing here changes the old document.
  const RESTART_DROPS = ["bills", "yearlyBills", "monthlyBudgets", "billOverrides", "budgets", "budgetDefault"];
  const CARD_RULE = { match: "member credit card", transfer: "Card" };
  const clone = x => JSON.parse(JSON.stringify(x));
  const kept = (rows, start) => (rows || []).filter(r => r.date >= start);
  const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bill";
  const descOf = r => String(r.name || "").toLowerCase().replace(/\s+/g, " ").trim();

  // An id for a new bill that no bill in `bills` has yet.
  function newBillId(name, bills) {
    const used = new Set((bills || []).map(b => b.id));
    let id = slug(name);
    for (let n = 2; used.has(id); n++) id = slug(name) + "-" + n;
    return id;
  }

  // Rules with the new names: Savings → transfer to/from savings, Credit →
  // card repayment, old categories renamed (old rules were for spending, so
  // "Gifts" stays a spending category); plus the card-repayment rule.
  function restartRules(rules) {
    const out = (rules || []).map(r => {
      if (!r || r.transfer) return r;
      const c = r.category;
      if (c === "Savings") return { match: r.match, transfer: "Savings" };
      if (c === "Credit") return { match: r.match, transfer: "Card" };
      if (!SPEND_CATS.includes(c) && !OLD_SPEND[c] && (INCOME_CATS.includes(c) || OLD_INCOME[c])) return { match: r.match, category: newIncomeCat(c) };
      return { match: r.match, category: newSpendCat(c) };
    });
    return normaliseRules([CARD_RULE].concat(out));
  }

  // What the old Reconcile tab linked to each bill: the description and
  // account seen most often (the latest on a tie), as a starting match text
  // and account.
  function billHistory(old) {
    const seen = {};
    const bump = (m, k, date) => { const x = m[k] = m[k] || { n: 0, last: "" }; x.n++; if ((date || "") > x.last) x.last = date; };
    (old.transactions || []).forEach(r => {
      const names = r.billSplits && r.billSplits.length ? r.billSplits.map(s => s.bill) : [r.bill];
      new Set(names.filter(Boolean)).forEach(name => {
        const h = seen[name] = seen[name] || { desc: {}, account: {} };
        if (descOf(r)) bump(h.desc, descOf(r), r.date);
        bump(h.account, accountOf(r), r.date);
      });
    });
    const top = m => Object.keys(m).sort((a, b) => m[b].n - m[a].n || m[b].last.localeCompare(m[a].last) || a.localeCompare(b))[0];
    const out = {};
    Object.keys(seen).forEach(name => { out[name] = { match: top(seen[name].desc) || "", account: top(seen[name].account) || "Flex" }; });
    return out;
  }

  // Bills to set up: the monthly bills at this month's amounts (or the
  // latest month budgeted), the yearly bills, and the card-repayment
  // reminder. Due dates are left for you to fill in; £0 bills start unticked.
  function draftBills(old, start, today) {
    const mb = old.monthlyBudgets || {}, cur = (today || start).slice(0, 7);
    const months = Object.keys(mb).sort();
    const month = months.filter(m => m <= cur).pop() || months[0];
    const amounts = (month && mb[month] && mb[month].bills) || {};
    const history = billHistory(old), out = [];
    const add = (b, freq, amount) => {
      const h = history[b.name] || {};
      out.push({
        id: newBillId(b.name, out), name: b.name, notes: b.notes || "", match: h.match || "",
        freq, amount: round2(amount), dueDay: null, dueDate: null, account: h.account || "Flex",
        reminder: false, include: round2(amount) > 0,
      });
    };
    (old.bills || []).forEach(b => add(b, "monthly", +amounts[b.name] || 0));
    (old.yearlyBills || []).forEach(b => add(b, "yearly", +b.amount || 0));
    out.push({
      id: newBillId("credit-card-repayment", out), name: "Credit card repayment", notes: "Reminder only: a transfer, not counted in bills",
      match: CARD_RULE.match, freq: "monthly", amount: 0, dueDay: null, dueDate: null, account: "Flex", reminder: true, include: true,
    });
    return out;
  }

  // The standard budget to start from: the start month's budget × 12/13
  // (13 periods a year), rounded to the pound, under the new names. Bills
  // come from the Bills tab instead; the Savings budget becomes the
  // savings target.
  function draftBudget(old, start) {
    const src = (((old.monthlyBudgets || {})[start.slice(0, 7)] || {}).categories) || {};
    const cats = {};
    SPEND_CATS.forEach(c => { if (c !== "Bills") cats[c] = 0; });
    let savings = 0;
    Object.keys(src).forEach(c => {
      const per = Math.round((+src[c] || 0) * 12 / 13);
      if (c === "Savings") savings += per;
      else if (c !== "Bills" && c !== "Credit") cats[newSpendCat(c)] += per;
    });
    return { cats, savings };
  }

  // Everything the wizard shows before anything is saved.
  //   openings  balances at the close of the day before the start
  //   review    kept rows whose meaning isn't clear (see needsReview), with
  //             what they'll become (now) and what the rules suggest
  function restartPreview(old, startIso, today) {
    const start = startIso || P.DEFAULT_CYCLE.anchor, close = P.addDays(start, -1);
    const cats = old.categories || [], rules = restartRules(old.rules);
    const ruleDoc = { incomeCategories: INCOME_CATS };
    const review = [];
    [["out", kept(old.transactions, start)], ["in", kept(old.income, start)]].forEach(([dir, rows]) => rows.forEach(row => {
      if (!needsReview(row, dir)) return;
      const now = classify(convertRow(row, dir, cats), dir);
      review.push({ dir, id: row.id, row, now, suggestion: fromRule(ruleFor(rules, row.name), dir, ruleDoc) });
    }));
    const count = (rows, k) => (rows || []).length - k;
    const keptOut = kept(old.transactions, start).length, keptIn = kept(old.income, start).length;
    return {
      start, close, openings: balances(old, close),
      counts: { kept: { out: keptOut, in: keptIn }, archived: { out: count(old.transactions, keptOut), in: count(old.income, keptIn) } },
      bills: draftBills(old, start, today), budget: draftBudget(old, start), rules, review,
    };
  }

  // Anything in the wizard's choices that would make a broken budget, as
  // messages to show; an empty list means it's safe to confirm.
  const validDueDate = s => {
    const m = /^(\d{2})-(\d{2})$/.exec(s || "");
    return !!m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= P.daysInMonth(2024, +m[1]);
  };
  const validDueDay = d => num(d) != null && Number.isInteger(+d) && +d >= 1 && +d <= 31;
  // What's wrong with a bill as typed — {name, amount, freq, dueDay or
  // dueDate, account} — as messages; [] when it's fine.
  function billProblems(b) {
    const out = [], name = String(b.name || "").trim(), n = name || "A bill";
    if (!name) out.push("A bill has no name.");
    if (num(b.amount) == null || +b.amount < 0) out.push(n + ": amount needs a number.");
    if (b.freq === "yearly") { if (!validDueDate(b.dueDate)) out.push(n + ": set the due date (day and month)."); }
    else if (b.freq === "monthly") { if (!validDueDay(b.dueDay)) out.push(n + ": set the due day (1–31)."); }
    else out.push(n + ": monthly or yearly?");
    if (b.account !== "Flex" && b.account !== "Card") out.push(n + ": paid from Flex or the card?");
    return out;
  }
  function restartProblems(choices) {
    const out = [], c = choices || {}, o = c.openings || {};
    if (num(o.flex) == null) out.push("Opening Flex balance needs a number.");
    if (num(o.card) == null) out.push("Opening card balance needs a number.");
    const ids = new Set();
    (c.bills || []).filter(b => b.include).forEach(b => {
      const n = String(b.name || "").trim() || "A bill";
      if (ids.has(b.id)) out.push(n + ": two bills have the same id."); else ids.add(b.id);
      out.push(...billProblems(b));
    });
    Object.keys(c.review || {}).forEach(k => {
      const v = c.review[k] || {}, dir = k.split(":")[0];
      const ok = v.type === "Transfer" ? TRANSFER_ACCOUNTS.includes(v.other)
        : v.type === "Income" ? dir === "in" && INCOME_CATS.includes(v.category)
          : v.type === "Refund" ? dir === "in" && SPEND_CATS.includes(v.category)
            : v.type === "Spend" ? dir === "out" && SPEND_CATS.includes(v.category) : false;
      if (!ok) out.push("A reviewed row needs a type and category that fit it.");
    });
    return out;
  }

  // The new live document. `choices` comes from the wizard:
  //   {start, openings: {flex, card}, bills: [draft bills, edited],
  //    budget: {cats, savings}, review: {"out:<id>" | "in:<id>": {type, category, other}}}
  // Categories, rules (renamed), savings pots, cash and wealth history are
  // kept; rows before the start and the old budget structures are not.
  function restartDoc(old, choices) {
    const c = choices || {}, src = clone(old);
    const start = c.start || P.DEFAULT_CYCLE.anchor, cats = src.categories || [];
    const decisions = c.review || {};
    const convert = dir => row => {
      const out = convertRow(row, dir, cats), k = decisions[dir + ":" + row.id];
      return k ? setKind(out, dir, k) : out;
    };
    const doc = {};
    Object.keys(src).forEach(k => { if (!RESTART_DROPS.includes(k)) doc[k] = src[k]; });
    doc.meta = Object.assign({}, src.meta, { startDate: start, version: 2 });
    doc.categories = SPEND_CATS.slice();
    doc.incomeCategories = INCOME_CATS.slice();
    doc.rules = restartRules(src.rules);
    doc.accounts = Object.assign({}, src.accounts, {
      openingFlex: round2(num(c.openings && c.openings.flex) || 0),
      openingCredit: round2(num(c.openings && c.openings.card) || 0),
    });
    doc.transactions = kept(src.transactions, start).map(convert("out"));
    doc.income = kept(src.income, start).map(convert("in"));
    doc.payCycle = { anchor: start, days: P.DEFAULT_CYCLE.days, overrides: {} };
    doc.recurringBills = (c.bills || []).filter(b => b.include).map(b => {
      const v = { from: start, amount: round2(b.amount), freq: b.freq === "yearly" ? "yearly" : "monthly", account: b.account === "Card" ? "Card" : "Flex" };
      if (v.freq === "yearly") v.dueDate = b.dueDate; else v.dueDay = +b.dueDay;
      return { id: b.id, name: String(b.name).trim(), match: String(b.match || "").trim(), notes: b.notes || "", reminder: !!b.reminder, versions: [v], overrides: {} };
    });
    const budget = c.budget || { cats: {}, savings: 0 }, std = {};
    Object.keys(budget.cats || {}).forEach(k => { std[k] = round2(num(budget.cats[k]) || 0); });
    doc.budget = { standard: [{ from: start, cats: std, savings: round2(num(budget.savings) || 0) }], periods: {} };
    return doc;
  }

  // A restarted document as this version of the app expects it: anything
  // missing is filled in, and what an older copy of the app does to one is
  // undone — it adds the old monthly budget lists back, and saves transfer
  // rules without their transfer. Changes `doc` in place; returns
  // {doc, notes}, notes saying what was repaired.
  function tidyDoc(doc) {
    const notes = [];
    const isObj = x => !!x && typeof x === "object" && !Array.isArray(x);
    if (!Array.isArray(doc.categories) || !doc.categories.length) doc.categories = SPEND_CATS.slice();
    if (!Array.isArray(doc.incomeCategories) || !doc.incomeCategories.length) doc.incomeCategories = INCOME_CATS.slice();
    doc.payCycle = P.normCycle(Object.assign({ anchor: startOf(doc) }, doc.payCycle));
    const bills = Array.isArray(doc.recurringBills) ? doc.recurringBills.filter(isObj) : [];
    bills.forEach(b => {
      if (!b.id) b.id = newBillId(b.name, bills);
      if (!Array.isArray(b.versions)) b.versions = [];
      if (!isObj(b.overrides)) b.overrides = {};
    });
    doc.recurringBills = bills;
    const budget = doc.budget = isObj(doc.budget) ? doc.budget : {};
    if (!Array.isArray(budget.standard)) budget.standard = [];
    if (!isObj(budget.periods)) budget.periods = {};

    const old = RESTART_DROPS.filter(k => k in doc);
    if (old.length) {
      old.forEach(k => { delete doc[k]; });
      notes.push("Removed the old monthly budget lists that an older version of the app put back.");
    }
    let fixed = 0;
    const rules = (doc.rules || []).map(r => {
      if (!r || r.transfer || r.category || !String(r.match || "").trim()) return r;
      fixed++;
      return { match: r.match, transfer: /credit card/i.test(r.match) ? "Card" : "Savings" };
    });
    doc.rules = normaliseRules(rules);
    if (fixed) notes.push("Repaired " + fixed + " transfer rule" + (fixed === 1 ? "" : "s") + " that an older version of the app had saved without the transfer.");
    return { doc, notes };
  }

  return {
    TYPES, SPEND_CATS, INCOME_CATS, TRANSFER_ACCOUNTS, OLD_SPEND, OLD_INCOME,
    accountOf, isRestarted, spendCats, incomeCats, round2,
    classify, effects, ledger, balances,
    normaliseRules, ruleFor, fromRule, setKind,
    newSpendCat, newIncomeCat, convertRow, needsReview,
    MATCH_DAYS, OVERDUE_DAYS, cycleOf, startOf,
    billVersion, billOccurrences, billTimeline, billStatus, describeBill, periodBills, billPaymentIds,
    changeBillFrom, endBillFrom, overrideBill,
    rowPeriodKey, budgetFor, setBudget, resetBudget, setPay, setPayday,
    periodFlows, payFor, periodBudget, untilPayday,
    newBillId, billProblems, restartRules, restartPreview, restartProblems, restartDoc, tidyDoc,
  };
});
