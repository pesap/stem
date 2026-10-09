import assert from "node:assert/strict";
import test from "node:test";

import { formatIsoDuration, validateIsoDuration } from "../src/duration.js";

test("formats fixed ISO durations as the smallest exact Julia period", () => {
  assert.equal(formatIsoDuration("P1D"), "Day(1)");
  assert.equal(formatIsoDuration("P1DT12H"), "Hour(36)");
  assert.equal(formatIsoDuration("P1W"), "Week(1)");
  assert.equal(formatIsoDuration("PT15M"), "Minute(15)");
  assert.equal(formatIsoDuration("PT1H30M"), "Minute(90)");
  assert.equal(formatIsoDuration("PT0H1S"), "Second(1)");
});

test("rejects calendar durations, malformed order, zero, and overflow", () => {
  for (const value of [
    "P1Y",
    "P1M",
    "P1W2D",
    "P1DT1D",
    "PT1S1M",
    "PT",
    "PT0S",
    "P1.5D",
  ]) {
    assert.throws(() => formatIsoDuration(value), /.+/, value);
  }
  assert.throws(
    () => formatIsoDuration("P999999999999999999999D"),
    /too large/,
  );
});

test("duration validation exposes the same acceptance contract", () => {
  assert.equal(validateIsoDuration("PT15M"), undefined);
  assert.throws(() => validateIsoDuration("P1M"));
});
