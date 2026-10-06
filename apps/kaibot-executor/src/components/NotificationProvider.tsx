import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { API_BASE_URL } from '../lib/config';
import { ensurePermission, notify, type NotificationEventType } from '../lib/notifications';
import { apiFetch, getAuthToken } from '../lib/api';
import {
  activityEventsAtom,
  backendLinkAtom,
  lastSignalAtAtom,
  updateInfoAtom,
  type ActivityEvent,
} from '../lib/atoms';

interface BackendNotificationEvent {
  type: NotificationEventType;
  title: string;
  body: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

const MAX_ACTIVITY_EVENTS = 200;

/**
 * Connects to the executor backend notification WebSocket and forwards
 * events to the native notification helper. Lives at the root of the app so
 * it's active across all routes.
 */
export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const setActivityEvents = useSetAtom(activityEventsAtom);
  const setBackendLink = useSetAtom(backendLinkAtom);
  const setLastSignalAt = useSetAtom(lastSignalAtAtom);
  const setUpdateInfo = useSetAtom(updateInfoAtom);

  useEffect(() => {
    // Ask for permission once at mount — the OS will only show the dialog on
    // the first call, later calls are no-ops.
    ensurePermission().catch(() => undefined);

    let cancelled = false;
    let detachListeners: (() => void) | null = null;

    const buildWsUrl = () => {
      // API_BASE_URL may be empty ('' in web dev mode — Vite proxy handles it)
      // in which case we derive from window.location.
      const base = API_BASE_URL
        ? API_BASE_URL.replace(/^http/, 'ws') + '/api/ws/notifications'
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws/notifications`;
      // Web mode authenticates the upgrade with the session token; WebSocket()
      // can't set headers, so it rides as a query param. Desktop (loopback)
      // has no token and needs none.
      const token = getAuthToken();
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    };

    const connect = () => {
      if (cancelled) return;
      setBackendLink('connecting');
      try {
        const ws = new WebSocket(buildWsUrl());
        wsRef.current = ws;

        const onOpen = () => {
          if (!cancelled) setBackendLink('online');
        };

        const onMessage = (ev: MessageEvent) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg?.type === 'hello') {
              setBackendLink('online');
              return;
            }
            if (msg?.type === 'notification' && msg.event) {
              const event = msg.event as BackendNotificationEvent;
              // Surface in the in-app activity feed.
              const activity: ActivityEvent = {
                id: `${event.type}-${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
                type: event.type,
                title: event.title,
                body: event.body,
                timestamp: event.timestamp,
                data: event.data,
              };
              setActivityEvents((prev) => [activity, ...prev].slice(0, MAX_ACTIVITY_EVENTS));
              if (event.type === 'signal_received') {
                setLastSignalAt(event.timestamp);
              }
              if (event.type === 'update_available' || event.type === 'update_required') {
                const d = event.data as { latestVersion?: string; current?: string; required?: string } | undefined;
                setUpdateInfo({
                  latestVersion: String(d?.latestVersion ?? d?.required ?? ''),
                  current: String(d?.current ?? ''),
                  required: event.type === 'update_required',
                });
              }
              // Fire the native/OS notification.
              void notify({
                type: event.type,
                title: event.title,
                body: event.body,
                dedupeKey: `${event.type}:${event.title}:${event.body}`,
              });
            }
          } catch {
            /* ignore malformed */
          }
        };

        const onClose = () => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('message', onMessage);
          ws.removeEventListener('close', onClose);
          ws.removeEventListener('error', onError);
          wsRef.current = null;
          if (!cancelled) {
            setBackendLink('offline');
            scheduleReconnect();
          }
        };

        const onError = () => {
          // let close handler reconnect
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        };

        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        ws.addEventListener('error', onError);
        detachListeners = () => {
          ws.removeEventListener('open', onOpen);
          ws.removeEventListener('message', onMessage);
          ws.removeEventListener('close', onClose);
          ws.removeEventListener('error', onError);
        };
      } catch {
        setBackendLink('offline');
        scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      if (reconnectTimerRef.current) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, 3000);
    };

    // Hydrate the soft-update banner from the backend's current state, so a
    // notification that fired before this UI mounted isn't missed.
    apiFetch('/api/ws/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => {
        if (cancelled || !status?.update?.latestVersion) return;
        setUpdateInfo({
          latestVersion: status.update.latestVersion,
          current: status.update.current ?? status.version ?? '',
        });
      })
      .catch(() => undefined);

    connect();

    return () => {
      cancelled = true;
      if (detachListeners) {
        detachListeners();
        detachListeners = null;
      }
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, [setActivityEvents, setBackendLink, setLastSignalAt]);

  return <>{children}</>;
}
