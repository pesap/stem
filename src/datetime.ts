export function parseCalendarDate(source: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
  if (!match) {
    throw new Error("date must use YYYY-MM-DD");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) {
    throw new Error("date is outside the supported calendar range");
  }

  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`day is not valid for ${match[1]}-${match[2]}`);
  }
  return date;
}

export function formatCalendarDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeTimeOfDay(source: string): string {
  const parts = source.split(":");
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !/^\d{2}$/.test(part))
  ) {
    throw new Error("time must use HH:MM or HH:MM:SS");
  }

  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = parts.length === 3 ? Number(parts[2]) : 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("time must be within 00:00:00 and 23:59:59");
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

export function normalizeIsoDateTime(source: string): string {
  const { date, time } = splitDateTime(source);
  return `${date}T${time}`;
}

export function splitDateTime(source: string): { date: string; time: string } {
  const separator = source.indexOf("T");
  if (separator < 0 || source.indexOf("T", separator + 1) >= 0) {
    throw new Error("date-time must separate date and time with `T`");
  }

  const date = source.slice(0, separator);
  const time = source.slice(separator + 1);
  parseCalendarDate(date);
  if (!time) {
    throw new Error("time of day is missing");
  }
  return { date, time: normalizeTimeOfDay(time) };
}
