const MAX_INT64 = 9_223_372_036_854_775_807n;
const SECONDS_PER_DAY = 86_400n;

const DATE_UNITS = new Map([
  ["W", { rank: 1, seconds: 7n * SECONDS_PER_DAY }],
  ["D", { rank: 2, seconds: SECONDS_PER_DAY }],
]);
const TIME_UNITS = new Map([
  ["H", { rank: 1, seconds: 3_600n }],
  ["M", { rank: 2, seconds: 60n }],
  ["S", { rank: 3, seconds: 1n }],
]);

export function formatIsoDuration(source: string): string {
  if (!source.startsWith("P")) {
    throw new Error("duration must begin with `P`");
  }

  let inTime = false;
  let sawTimeMarker = false;
  let sawTimeUnit = false;
  let sawWeek = false;
  let sawOtherUnit = false;
  let number = "";
  let dateRank = 0;
  let timeRank = 0;
  let totalSeconds = 0n;

  for (const character of source.slice(1)) {
    if (character === "T") {
      if (sawTimeMarker || number.length > 0) {
        throw new Error("`T` must appear once between date and time units");
      }
      sawTimeMarker = true;
      inTime = true;
      continue;
    }

    if (character >= "0" && character <= "9") {
      number += character;
      continue;
    }

    if (number.length === 0) {
      throw new Error(`missing whole-number amount before '${character}'`);
    }

    const amount = BigInt(number);
    number = "";
    const unit = (inTime ? TIME_UNITS : DATE_UNITS).get(character);

    if (!unit) {
      if (!inTime && (character === "Y" || character === "M")) {
        throw new Error(
          "calendar years and months are not supported for fixed simulation periods",
        );
      }
      throw new Error(`unsupported ISO 8601 duration unit '${character}'`);
    }

    const lastRank = inTime ? timeRank : dateRank;
    if (unit.rank <= lastRank) {
      throw new Error("ISO 8601 duration units must be unique and ordered");
    }
    if (inTime) {
      sawTimeUnit = true;
      timeRank = unit.rank;
    } else {
      dateRank = unit.rank;
    }

    if (character === "W") {
      if (sawOtherUnit) {
        throw new Error(
          "ISO 8601 week durations cannot be combined with other units",
        );
      }
      sawWeek = true;
    } else {
      if (sawWeek) {
        throw new Error(
          "ISO 8601 week durations cannot be combined with other units",
        );
      }
      sawOtherUnit = true;
    }

    const unitSeconds = amount * unit.seconds;
    totalSeconds += unitSeconds;
    if (
      amount > MAX_INT64 ||
      unitSeconds > MAX_INT64 ||
      totalSeconds > MAX_INT64
    ) {
      throw new Error("duration is too large to represent as a Julia period");
    }
  }

  if (number.length > 0) {
    throw new Error("duration amount is missing a unit");
  }
  if (sawTimeMarker && !sawTimeUnit) {
    throw new Error("`T` must be followed by a time unit");
  }
  if (totalSeconds === 0n) {
    throw new Error("duration must be greater than zero");
  }
  if (sawWeek) {
    return `Week(${totalSeconds / (7n * SECONDS_PER_DAY)})`;
  }

  for (const [seconds, juliaType] of [
    [SECONDS_PER_DAY, "Day"],
    [3_600n, "Hour"],
    [60n, "Minute"],
    [1n, "Second"],
  ] as const) {
    if (totalSeconds % seconds === 0n) {
      return `${juliaType}(${totalSeconds / seconds})`;
    }
  }

  return `Second(${totalSeconds})`;
}

export function validateIsoDuration(source: string): void {
  formatIsoDuration(source);
}
