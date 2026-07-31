/**
 * Notification helper — uses Tauri's native notification plugin when running
 * inside the desktop app and falls back to the Web Notifications API when
 * running in a plain browser (dev mode).
 *
 * Also centralises preference reading, per-event-type filtering, rate-limit
 * debouncing and the optional beep sound.
 */

export type NotificationEventType =
  | 'signal_received'
  | 'order_filled'
  | 'order_rejected'
  | 'connection_lost'
  | 'connection_restored'
  | 'update_available'
  | 'update_required'
  | 'error';

export interface NotificationPrefs {
  enabled: boolean;
  sound: boolean;
  events: Record<NotificationEventType, boolean>;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  sound: false,
  events: {
    signal_received: true,
    order_filled: true,
    order_rejected: true,
    connection_lost: true,
    connection_restored: false,
    update_available: true,
    update_required: true,
    error: true,
  },
};

const PREFS_STORAGE_KEY = 'kaibot-executor-notification-prefs';

export function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_NOTIFICATION_PREFS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...parsed,
      events: { ...DEFAULT_NOTIFICATION_PREFS.events, ...(parsed?.events ?? {}) },
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

export function savePrefs(prefs: NotificationPrefs) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Request permission once. Handles both Tauri native and Web Notifications.
 */
export async function ensurePermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-notification');
      let granted = await mod.isPermissionGranted();
      if (!granted) {
        const res = await mod.requestPermission();
        granted = res === 'granted';
      }
      return granted;
    } catch (err) {
      console.warn('[notifications] Tauri plugin unavailable, falling back to Web API', err);
    }
  }

  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const res = await Notification.requestPermission();
    return res === 'granted';
  } catch {
    return false;
  }
}

/**
 * Debounce dedupe key → timestamp. Similar events within the window
 * are suppressed to avoid spamming the user.
 */
const DEBOUNCE_WINDOW_MS = 2000;
const lastSeen = new Map<string, number>();

function shouldEmit(key: string): boolean {
  const now = Date.now();
  const prev = lastSeen.get(key);
  if (prev && now - prev < DEBOUNCE_WINDOW_MS) return false;
  lastSeen.set(key, now);
  return true;
}

/**
 * Play a short beep using Web Audio API. Cheap and dependency-free.
 */
function playBeep() {
  try {
    const Ctx: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => ctx.close().catch(() => undefined);
  } catch {
    /* ignore */
  }
}

export interface NotifyInput {
  type: NotificationEventType;
  title: string;
  body: string;
  dedupeKey?: string;
}

/**
 * Main entry point: check prefs, debounce, dispatch via Tauri or Web API.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const prefs = loadPrefs();
  if (!prefs.enabled) return;
  if (!prefs.events[input.type]) return;

  const key = input.dedupeKey ?? `${input.type}:${input.title}`;
  if (!shouldEmit(key)) return;

  const granted = await ensurePermission();
  if (!granted) return;

  if (prefs.sound) playBeep();

  if (isTauri()) {
    try {
      const mod = await import('@tauri-apps/plugin-notification');
      mod.sendNotification({ title: input.title, body: input.body });
      return;
    } catch (err) {
      console.warn('[notifications] Tauri send failed, falling back', err);
    }
  }

  try {
    new Notification(input.title, { body: input.body });
  } catch (err) {
    console.warn('[notifications] Web Notification send failed', err);
  }
}
