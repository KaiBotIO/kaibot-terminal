export interface FmtDateTimeOpts {
  tz?: "local" | "utc";
}

function toDate(d: Date | number | string): Date {
  return d instanceof Date ? d : new Date(d);
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
    ...(opts?.tz === "utc" ? { timeZone: "UTC" } : {}),
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
    ...(opts?.tz === "utc" ? { timeZone: "UTC" } : {}),
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
