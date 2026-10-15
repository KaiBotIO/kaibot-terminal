import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { TRADESTATION_AUTH_MODE_OVERRIDE, type TradestationAuthMode } from '@/lib/config';

// Which TradeStation connect form to render. The backend decides (it owns the
// CouchDB credentials); anything unexpected falls back to OAuth, the only path
// a user outside Kai's box can complete.
export function useTradestationAuthMode(enabled = true): TradestationAuthMode {
  const [mode, setMode] = useState<TradestationAuthMode>(
    TRADESTATION_AUTH_MODE_OVERRIDE ?? 'oauth',
  );

  useEffect(() => {
    if (!enabled || TRADESTATION_AUTH_MODE_OVERRIDE) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await apiFetch('/api/config');
        if (!res.ok) return;
        const body = (await res.json()) as { tradestationAuthMode?: string };
        if (!cancelled && body.tradestationAuthMode === 'couchdb') setMode('couchdb');
      } catch {
        /* keep the OAuth default */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return mode;
}
