"use strict";
/* =========================================================================
   Pay periods and bill schedules — pure date maths, no DOM, no DATA.

   You're paid every 4 weeks, so a budget "period" runs from one payday to
   the day before the next. Bills are still mostly monthly, so this module
   also answers "which bills fall due between these two dates?".

   All dates are ISO strings ("2026-09-18") and all arithmetic is done in
   UTC days, so clock changes can never shift a period by a day.

   Loaded in the browser as window.Periods; required by Node for tests.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Periods = api;
})(typeof self !== "undefined" ? self : this, function () {
  const DAY = 86400000;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DEFAULT_CYCLE = Object.freeze({ anchor: "2026-09-18", days: 28, overrides: {} });

  /* ---------- day arithmetic ---------- */
  const toDays = iso => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
  const fromDays = n => new Date(n * DAY).toISOString().slice(0, 10);
  const addDays = (iso, n) => fromDays(toDays(iso) + n);
  const diffDays = (a, b) => toDays(b) - toDays(a);              // b − a
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();   // m is 1-12
  const fmt = iso => { const [, m, d] = iso.split("-").map(Number); return d + " " + MONTHS[m - 1]; };
  const fmtY = iso => fmt(iso) + " " + iso.slice(0, 4);

  function normCycle(c) {
    c = c || {};
    const days = Math.max(1, Math.round(+c.days || DEFAULT_CYCLE.days));
    return { anchor: c.anchor || DEFAULT_CYCLE.anchor, days, overrides: c.overrides || {} };
  }

  /* ---------- paydays ----------
     Payday n is anchor + n×days, unless overrides maps that scheduled date
     to the day the money actually arrived (e.g. early for a bank holiday).
     An override may move a payday by less than half a period, which keeps
     paydays in order; anything further is ignored. */
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  function scheduledPayday(cycle, n) { const c = normCycle(cycle); return addDays(c.anchor, n * c.days); }
  function payday(cycle, n) {
    const c = normCycle(cycle), s = scheduledPayday(c, n), o = c.overrides[s];
    return o && ISO_RE.test(o) && Math.abs(diffDays(s, o)) * 2 < c.days ? o : s;
  }
  // index of the period containing `iso` (negative before the anchor)
  function indexFor(cycle, iso) {
    const c = normCycle(cycle);
    let n = Math.floor(diffDays(c.anchor, iso) / c.days);
    // overrides can nudge a boundary by a few days either way
    while (payday(c, n) > iso) n--;
    while (payday(c, n + 1) <= iso) n++;
    return n;
  }
  // `key` is the scheduled payday, so it stays the same when the payday is
  // moved; anything stored per period (budgets, "count in") uses the key.
  function periodAt(cycle, n) {
    const start = payday(cycle, n), next = payday(cycle, n + 1), end = addDays(next, -1);
    return { index: n, key: scheduledPayday(cycle, n), start, end, next, days: diffDays(start, next) };
  }
  const periodFor = (cycle, iso) => periodAt(cycle, indexFor(cycle, iso));
  function periodByKey(cycle, key) {
    if (!ISO_RE.test(key || "")) return null;
    const c = normCycle(cycle), n = diffDays(c.anchor, key) / c.days;
    return Number.isInteger(n) ? periodAt(c, n) : null;
  }
  // every period overlapping [fromIso, toIso], oldest first
  function periodsBetween(cycle, fromIso, toIso) {
    if (toIso < fromIso) return [];
    const out = [];
    for (let n = indexFor(cycle, fromIso), last = indexFor(cycle, toIso); n <= last; n++) out.push(periodAt(cycle, n));
    return out;
  }
  // first payday strictly after `iso`
  const nextPayday = (cycle, iso) => periodFor(cycle, iso).next;
  const label = p => fmt(p.start) + " – " + fmt(p.end);
  const labelLong = p => fmt(p.start) + " – " + fmtY(p.end);

  /* ---------- bill schedules ----------
     Monthly bill: {dueDay: 1-31}. A due day past the end of a short month
     falls on that month's last day (31 → 30 Apr, 28/29 Feb).
     Yearly bill:  {dueDate: "MM-DD"}.
     A 28-day period can never hold two dates of the same monthly bill
     (consecutive due dates are always ≥ 28 days apart), so each monthly
     bill lands in 12 of the ~13 periods a year and skips one. */
  function monthlyDueDate(y, m, dueDay) {
    const d = Math.min(Math.max(1, Math.round(dueDay)), daysInMonth(y, m));
    return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }
  function occurrences(bill, fromIso, toIso) {
    if (!bill || toIso < fromIso) return [];
    const out = [];
    if (bill.dueDate) {                                        // yearly
      const [mm, dd] = String(bill.dueDate).split("-").map(Number);
      if (!mm || !dd) return [];
      for (let y = +fromIso.slice(0, 4); y <= +toIso.slice(0, 4); y++) {
        const iso = monthlyDueDate(y, mm, dd);
        if (iso >= fromIso && iso <= toIso) out.push(iso);
      }
      return out;
    }
    if (!(+bill.dueDay >= 1)) return [];                       // no due day set yet
    let y = +fromIso.slice(0, 4), m = +fromIso.slice(5, 7);
    const ey = +toIso.slice(0, 4), em = +toIso.slice(5, 7);
    while (y < ey || (y === ey && m <= em)) {
      const iso = monthlyDueDate(y, m, bill.dueDay);
      if (iso >= fromIso && iso <= toIso) out.push(iso);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }
  // the long-run cost of a bill per pay period, for comparison only:
  // a year is 13 periods of 28 days, so monthly × 12/13 and yearly ÷ 13
  function smoothedPerPeriod(amount, kind, cycleDays) {
    const days = cycleDays || DEFAULT_CYCLE.days;
    const perYear = kind === "yearly" ? (+amount || 0) : (+amount || 0) * 12;
    return perYear * days / 364;
  }

  // today's date where you are (toISOString would give UTC, i.e. yesterday
  // between midnight and 1am in summer)
  function localISO(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  return {
    DEFAULT_CYCLE, MONTHS,
    toDays, fromDays, addDays, diffDays, daysInMonth, fmt, fmtY, localISO,
    normCycle, scheduledPayday, payday, indexFor, periodAt, periodFor, periodByKey, periodsBetween,
    nextPayday, label, labelLong,
    monthlyDueDate, occurrences, smoothedPerPeriod,
  };
});
