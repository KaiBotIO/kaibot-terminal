import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { apiFetch } from '@/lib/api';
import { signalServiceStatusAtom } from '@/lib/atoms';

/**
 * Polls the executor backend for the upstream signal-service WebSocket status
 * and tracks how long it has been down. The backend already handles
 * reconnect/backoff; this surfaces its current state to the UI.
 */
export function useConnectionStatus(pollMs = 5000) {
  const [status, setStatus] = useAtom(signalServiceStatusAtom);
  // Keep the first-seen "down" timestamp stable across polls.
  const downSinceRef = useRef<string | null>(status.downSince);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/ws/status');
        if (!res.ok) throw new Error(`ws status ${res.status}`);
        const data = (await res.json()) as { connected: boolean; status?: string };
        if (cancelled) return;

        const connected = !!data.connected;
        if (connected) {
          downSinceRef.current = null;
        } else if (!downSinceRef.current) {
          downSinceRef.current = new Date().toISOString();
        }

        setStatus({
          connected,
          status: data.status ?? (connected ? 'connected' : 'disconnected'),
          downSince: connected ? null : downSinceRef.current,
        });
      } catch {
        if (cancelled) return;
        if (!downSinceRef.current) downSinceRef.current = new Date().toISOString();
        setStatus({ connected: false, status: 'unreachable', downSince: downSinceRef.current });
      }
    };

    poll();
    const interval = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollMs, setStatus]);

  return status;
}
