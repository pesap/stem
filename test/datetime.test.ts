import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCalendarDate,
  normalizeIsoDateTime,
  normalizeTimeOfDay,
  parseCalendarDate,
  splitDateTime,
} from "../src/datetime.js";

test("validates Gregorian dates and preserves leap days", () => {
  assert.equal(
    formatCalendarDate(parseCalendarDate("2024-02-29")),
    "2024-02-29",
  );
  assert.throws(() => parseCalendarDate("2023-02-29"), /not valid/);
  assert.throws(() => parseCalendarDate("2024-13-01"), /calendar range/);
  assert.throws(() => parseCalendarDate("0000-01-01"), /calendar range/);
  assert.throws(() => parseCalendarDate("2024-2-01"), /YYYY-MM-DD/);
});

test("normalizes supported times and rejects invalid clock values", () => {
  assert.equal(normalizeTimeOfDay("13:05"), "13:05:00");
  assert.equal(normalizeTimeOfDay("13:05:42"), "13:05:42");
  assert.throws(() => normalizeTimeOfDay("24:00"), /within/);
  assert.throws(() => normalizeTimeOfDay("13:60"), /within/);
  assert.throws(() => normalizeTimeOfDay("1:05"), /HH:MM/);
});

test("normalizes custom ISO date-time input and rejects timezone or invalid values", () => {
  assert.equal(normalizeIsoDateTime("2024-02-29T13:05"), "2024-02-29T13:05:00");
  assert.equal(
    normalizeIsoDateTime("2024-02-29T13:05:42"),
    "2024-02-29T13:05:42",
  );
  assert.throws(() => normalizeIsoDateTime("2024-02-30T13:05"), /not valid/);
  assert.throws(() => normalizeIsoDateTime("2024-02-29T13:05Z"), /HH:MM/);
});

test("splits and validates an ISO-like local date-time", () => {
  assert.deepEqual(splitDateTime("2024-02-29T13:05"), {
    date: "2024-02-29",
    time: "13:05:00",
  });
  assert.throws(() => splitDateTime("2024-02-30T13:05"), /not valid/);
  assert.throws(() => splitDateTime("2024-02-29"), /separate date and time/);
});
