export interface FmtDateTimeOpts {
  tz?: "local" | "utc";
}

// App-wide display zone. Every page formats through here, so one setting moves
// all of them at once. Null = whatever zone the browser is in, which is the
// default and what a reader expects when nothing was chosen.
let displayTimeZone: string | null = null;

/** IANA zone name ('Europe/Brussels'), or null for the browser's own zone. */
export function setDisplayTimeZone(zone: string | null): void {
  if (zone && !isValidTimeZone(zone)) return;
  displayTimeZone = zone;
}

export function getDisplayTimeZone(): string | null {
  return displayTimeZone;
}

/** The zone timestamps actually render in, browser zone included. */
export function resolvedTimeZone(): string {
  return displayTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// 'utc' on the call site still wins: a few views deliberately state UTC.
function zoneOf(opts?: FmtDateTimeOpts): { timeZone?: string } {
  if (opts?.tz === "utc") return { timeZone: "UTC" };
  return displayTimeZone ? { timeZone: displayTimeZone } : {};
}

// SQLite CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS": UTC, but without a
// zone marker, so `new Date(...)` reads it as local time and shifts every
// executor timestamp by the UTC offset.
const NAIVE_SQL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Parse a timestamp, reading a zoneless SQL datetime as UTC.
 * Anything already carrying a zone (ISO with Z/offset, epoch ms, Date) is
 * untouched.
 */
export function parseTimestamp(d: Date | number | string): Date {
  if (d instanceof Date) return d;
  if (typeof d === "string" && NAIVE_SQL_DATETIME.test(d.trim())) {
    return new Date(`${d.trim().replace(" ", "T")}Z`);
  }
  return new Date(d);
}

function toDate(d: Date | number | string): Date {
  return parseTimestamp(d);
}

// Placeholder for an unparseable/missing date. Intl.DateTimeFormat.format
// THROWS on an invalid Date, so an unguarded call takes down the whole render
// tree — never let a single bad row do that.
const INVALID_DATE = "—";

/** "15 Jan 2026, 12:30 UTC" — always carries an explicit timezone label. */
export function fmtDateTime(d: Date | number | string, opts?: FmtDateTimeOpts): string {
  const date = toDate(d);
  if (Number.isNaN(date.getTime())) return INVALID_DATE;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    ...zoneOf(opts),
  }).format(date);
}

/** "15 Jan 2026" */
export function fmtDate(d: Date | number | string, opts?: FmtDateTimeOpts): string {
  const date = toDate(d);
  if (Number.isNaN(date.getTime())) return INVALID_DATE;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...zoneOf(opts),
  }).format(date);
}

/** "just now" | "5m" | "3h" | "2d" */
export function relativeTime(d: Date | string | number): string {
  const diffMs = Date.now() - toDate(d).getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  return `${day}d`;
}
