// Notification categories shown on the notifications page. Each maps to a set
// of event `source` values written via writeEvent(). The mapping lives here so
// the backend (events router filtering) and the frontend (filter tabs + icons)
// stay in sync.

export const NOTIFICATION_CATEGORIES = [
  'signal',
  'position',
  'bot',
  'backtest',
  'sentiment',
  'system',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

// Categories that belong in a user's PERSONAL feed + unread count. 'sentiment'
// is a global market-context layer (scanner writes one userId-null row per scan)
// and must never flood personal unread — it lives behind its own filter tab.
export const PERSONAL_NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES.filter(
  (c): c is Exclude<NotificationCategory, 'sentiment'> => c !== 'sentiment',
) as NotificationCategory[];

export function isPersonalCategory(category: NotificationCategory): boolean {
  return category !== 'sentiment';
}

// Event `source` -> category. Sources not listed fall back to 'system'.
export const EVENT_SOURCE_CATEGORY: Record<string, NotificationCategory> = {
  signal: 'signal',
  position: 'position',
  bot: 'bot',
  backtest: 'backtest',
  scanner: 'sentiment',
};

export function categoryForSource(source: string): NotificationCategory {
  return EVENT_SOURCE_CATEGORY[source] ?? 'system';
}

// Sources that map to a given category. Used server-side to translate a
// category filter into a `source IN (...)` clause.
export function sourcesForCategory(category: NotificationCategory): string[] {
  return Object.entries(EVENT_SOURCE_CATEGORY)
    .filter(([, c]) => c === category)
    .map(([source]) => source);
}

// Minimal shape linkForEvent needs from an event row.
export interface LinkableEvent {
  source: string;
  assetId?: string | null;
  metadata?: unknown;
}

// Where a notification row navigates on click. Resolution order: explicit
// metadata.link → known entity ids → source fallback → null (row stays inert).
export function linkForEvent(event: LinkableEvent): string | null {
  const meta = (
    typeof event.metadata === 'object' && event.metadata !== null ? event.metadata : {}
  ) as Record<string, unknown>;

  if (typeof meta.link === 'string' && meta.link.startsWith('/')) return meta.link;
  if (typeof meta.backtestId === 'string' && meta.backtestId)
    return `/backtests/${meta.backtestId}`;
  if (typeof meta.botId === 'string' && meta.botId) return `/bots/${meta.botId}`;
  if (typeof meta.forwardTestId === 'string' && meta.forwardTestId)
    return `/forward-tests/${meta.forwardTestId}`;

  const terminal = event.assetId
    ? `/terminal?symbol=${encodeURIComponent(event.assetId)}`
    : null;
  if (
    terminal &&
    (typeof meta.signalId === 'string' || typeof meta.positionGroupId === 'string')
  ) {
    return terminal;
  }
  if (terminal && (event.source === 'signal' || event.source === 'position')) return terminal;
  if (event.source === 'scanner') return '/sentiment';
  return null;
}

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  signal: 'Signals',
  position: 'Positions',
  bot: 'Bots',
  backtest: 'Backtests',
  sentiment: 'Sentiment',
  system: 'System',
};
