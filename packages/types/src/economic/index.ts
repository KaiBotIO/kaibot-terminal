// Economic-calendar types: the persisted event row and the per-bar
// ctx.calendar view injected into custom strategy code.

export type CalendarImpact = 'high' | 'medium' | 'low' | 'holiday';

// One persisted calendar event (economic_events row, DB-agnostic shape).
export interface EconomicEventRow {
  id: number;
  source: string; // 'forexfactory'
  title: string;
  currency: string; // feed 'country': USD, EUR, ALL, …
  impact: CalendarImpact;
  eventTs: number; // epoch ms
  forecast: string | null;
  previous: string | null;
  actual: string | null; // free feed carries none; column reserved
  url: string | null;
}

// Compact event list handed to the strategy runner once per run; the runner
// shapes the per-bar window from it. Sorted ascending by ts.
export interface CalendarEventLite {
  title: string;
  currency: string;
  impact: CalendarImpact;
  ts: number; // epoch ms
  forecast: string | null;
  previous: string | null;
  actual: string | null;
}

// One event as strategy code sees it (adds bar-relative timing).
export interface StrategyCalendarEvent extends CalendarEventLite {
  // Signed minutes between the bar timestamp and the event: positive = the
  // event is still ahead, negative = it already happened.
  minutesAway: number;
}

// The per-bar ctx.calendar view. Always present with the inert default
// (enabled:false, empty arrays) so user code checks status, never existence —
// same convention as ctx.ai.
export interface StrategyCalendar {
  enabled: boolean;
  // Events within the next CALENDAR_WINDOW_MS, ascending, capped.
  upcoming: StrategyCalendarEvent[];
  // Events within the past CALENDAR_WINDOW_MS, newest first, capped.
  recent: StrategyCalendarEvent[];
  // Nearest future high-impact event within CALENDAR_HIGH_LOOKAHEAD_MS —
  // deliberately wider than the ±window ("don't enter ahead of NFP").
  nextHighImpact: StrategyCalendarEvent | null;
}

export const CALENDAR_WINDOW_MS = 24 * 3_600_000;
export const CALENDAR_HIGH_LOOKAHEAD_MS = 7 * 24 * 3_600_000;
export const CALENDAR_MAX_EVENTS = 10;

export const INERT_CALENDAR: StrategyCalendar = Object.freeze({
  enabled: false,
  upcoming: [],
  recent: [],
  nextHighImpact: null,
});
