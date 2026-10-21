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

  return {
    TYPES, SPEND_CATS, INCOME_CATS, TRANSFER_ACCOUNTS, OLD_SPEND, OLD_INCOME,
    accountOf, isRestarted, spendCats, incomeCats, round2,
    classify, effects, ledger, balances,
    normaliseRules, ruleFor, fromRule, setKind,
    newSpendCat, newIncomeCat, convertRow, needsReview,
    MATCH_DAYS, OVERDUE_DAYS, cycleOf, startOf,
    billVersion, billOccurrences, billTimeline, billStatus, periodBills, billPaymentIds,
    changeBillFrom, endBillFrom, overrideBill,
  };
});
