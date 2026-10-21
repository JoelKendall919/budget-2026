"use strict";
// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../public/js/periods.js");

const C = P.DEFAULT_CYCLE;
const withOverrides = overrides => ({ ...C, overrides });

test("paydays run every 28 days from Fri 18 Sep 2026", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(n => P.payday(C, n)),
    ["2026-09-18", "2026-10-16", "2026-11-13", "2026-12-11", "2027-01-08"]);
  for (let n = 0; n < 30; n++) assert.equal(new Date(P.payday(C, n) + "T12:00:00Z").getUTCDay(), 5, "always a Friday");
});

test("a period runs from payday to the day before the next payday", () => {
  const p = P.periodFor(C, "2026-10-21");
  assert.deepEqual(p, { index: 1, key: "2026-10-16", start: "2026-10-16", end: "2026-11-12", next: "2026-11-13", days: 28 });
  assert.equal(P.label(p), "16 Oct – 12 Nov");
  assert.equal(P.labelLong(p), "16 Oct – 12 Nov 2026");
});

test("period boundaries fall exactly on paydays", () => {
  assert.equal(P.periodFor(C, "2026-10-15").start, "2026-09-18");
  assert.equal(P.periodFor(C, "2026-10-16").start, "2026-10-16");
  assert.equal(P.periodFor(C, "2026-11-12").start, "2026-10-16");
  assert.equal(P.periodFor(C, "2026-11-13").start, "2026-11-13");
});

test("dates before the first payday belong to earlier periods", () => {
  const p = P.periodFor(C, "2026-09-17");
  assert.equal(p.index, -1);
  assert.equal(p.start, "2026-08-21");
  assert.equal(p.end, "2026-09-17");
});

test("a period can cross the new year", () => {
  assert.equal(P.labelLong(P.periodFor(C, "2027-01-01")), "11 Dec – 7 Jan 2027");
});

test("day arithmetic ignores clock changes", () => {
  assert.equal(P.addDays("2026-10-24", 2), "2026-10-26");   // clocks go back 25 Oct 2026
  assert.equal(P.addDays("2027-03-27", 2), "2027-03-29");   // clocks go forward 28 Mar 2027
  assert.equal(P.diffDays("2026-10-24", "2026-10-26"), 2);
});

test("localISO uses the local date, not UTC", () => {
  assert.equal(P.localISO(new Date(2026, 9, 21, 0, 30)), "2026-10-21");
});

test("moving a payday early moves only that boundary", () => {
  const c = withOverrides({ "2026-12-11": "2026-12-10" });
  const before = P.periodAt(c, 2), moved = P.periodAt(c, 3), after = P.periodAt(c, 4);
  assert.deepEqual([before.start, before.end, before.days], ["2026-11-13", "2026-12-09", 27]);
  assert.deepEqual([moved.start, moved.end, moved.days], ["2026-12-10", "2027-01-07", 29]);
  assert.equal(after.start, "2027-01-08", "the 28-day rhythm carries on from the normal date");
  assert.equal(P.periodFor(c, "2026-12-09").index, 2);
  assert.equal(P.periodFor(c, "2026-12-10").index, 3);
  assert.equal(P.nextPayday(c, "2026-12-01"), "2026-12-10");
});

test("moving a payday late moves only that boundary", () => {
  const c = withOverrides({ "2026-12-11": "2026-12-14" });
  assert.equal(P.periodFor(c, "2026-12-13").end, "2026-12-13");
  assert.equal(P.periodFor(c, "2026-12-13").index, 2);
  assert.equal(P.periodFor(c, "2026-12-14").start, "2026-12-14");
  assert.equal(P.periodFor(c, "2027-01-08").start, "2027-01-08");
});

test("a period keeps its key when its payday is moved", () => {
  const c = withOverrides({ "2026-12-11": "2026-12-10" });
  assert.equal(P.periodAt(c, 3).key, "2026-12-11");
  assert.equal(P.periodByKey(c, "2026-12-11").start, "2026-12-10");
  assert.equal(P.periodFor(c, "2026-12-10").key, "2026-12-11");
});

test("unusable payday overrides are ignored", () => {
  const c = withOverrides({ "2026-12-11": "2026-12-25", "2027-01-08": "not a date" });
  assert.equal(P.payday(c, 3), "2026-12-11");
  assert.equal(P.payday(c, 4), "2027-01-08");
});

test("periodByKey only accepts real period keys", () => {
  assert.equal(P.periodByKey(C, "2026-11-13").end, "2026-12-10");
  assert.equal(P.periodByKey(C, "2026-11-14"), null);
  assert.equal(P.periodByKey(C, undefined), null);
});

test("periodsBetween lists every overlapping period, oldest first", () => {
  assert.deepEqual(P.periodsBetween(C, "2026-09-20", "2026-11-13").map(p => p.start),
    ["2026-09-18", "2026-10-16", "2026-11-13"]);
  assert.deepEqual(P.periodsBetween(C, "2026-11-13", "2026-09-20"), []);
});

test("nextPayday is the first payday after the date", () => {
  assert.equal(P.nextPayday(C, "2026-10-15"), "2026-10-16");
  assert.equal(P.nextPayday(C, "2026-10-16"), "2026-11-13");
  assert.equal(P.nextPayday(C, "2026-10-21"), "2026-11-13");
});

test("a due day past the end of a short month falls on its last day", () => {
  assert.equal(P.monthlyDueDate(2027, 4, 31), "2027-04-30");
  assert.equal(P.monthlyDueDate(2027, 2, 31), "2027-02-28");
  assert.equal(P.monthlyDueDate(2028, 2, 30), "2028-02-29");
  assert.deepEqual(P.occurrences({ dueDay: 31 }, "2027-04-02", "2027-05-27"), ["2027-04-30"]);
});

test("rent on the 1st is not due in 2–29 Apr 2027", () => {
  const rent = { dueDay: 1 };
  const missed = [];
  for (let n = 0; n < 13; n++) {
    const p = P.periodAt(C, n);
    if (!P.occurrences(rent, p.start, p.end).length) missed.push(P.label(p));
  }
  assert.deepEqual(missed, ["2 Apr – 29 Apr"]);
});

test("a monthly bill is never due twice in one 28-day period", () => {
  for (let day = 1; day <= 31; day++) {
    for (let n = 0; n < 40; n++) {
      const p = P.periodAt(C, n);
      assert.ok(P.occurrences({ dueDay: day }, p.start, p.end).length <= 1, `day ${day}, ${P.labelLong(p)}`);
    }
  }
});

test("yearly bills fall on their date each year", () => {
  assert.deepEqual(P.occurrences({ dueDate: "03-15" }, "2027-03-05", "2027-04-01"), ["2027-03-15"]);
  assert.deepEqual(P.occurrences({ dueDate: "01-02" }, "2026-12-11", "2027-01-07"), ["2027-01-02"]);
  assert.deepEqual(P.occurrences({ dueDate: "03-15" }, "2026-01-01", "2027-12-31"), ["2026-03-15", "2027-03-15"]);
  assert.deepEqual(P.occurrences({ dueDate: "02-29" }, "2027-01-01", "2027-12-31"), ["2027-02-28"]);
});

test("bills without a usable due date have no occurrences", () => {
  assert.deepEqual(P.occurrences({}, "2026-09-18", "2026-12-31"), []);
  assert.deepEqual(P.occurrences({ dueDay: 0 }, "2026-09-18", "2026-12-31"), []);
  assert.deepEqual(P.occurrences({ dueDate: "13" }, "2026-09-18", "2026-12-31"), []);
  assert.deepEqual(P.occurrences(null, "2026-09-18", "2026-12-31"), []);
});

test("smoothed cost per period is monthly × 12/13 or yearly ÷ 13", () => {
  assert.equal(P.smoothedPerPeriod(250, "monthly").toFixed(2), "230.77");
  assert.equal(P.smoothedPerPeriod(130, "yearly").toFixed(2), "10.00");
  assert.equal(P.smoothedPerPeriod("", "monthly"), 0);
});
