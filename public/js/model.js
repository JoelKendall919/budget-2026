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

  return {
    TYPES, SPEND_CATS, INCOME_CATS, TRANSFER_ACCOUNTS, OLD_SPEND, OLD_INCOME,
    accountOf, isRestarted, spendCats, incomeCats, round2,
    classify, effects, ledger, balances,
    normaliseRules, ruleFor, fromRule, setKind,
    newSpendCat, newIncomeCat, convertRow, needsReview,
  };
});
