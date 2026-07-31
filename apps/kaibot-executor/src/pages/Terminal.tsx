import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '@kaibot/shared';
import { useTerminalBridge } from '@/hooks/useTerminalBridge';
import { ONLINE_TERMINAL_URL } from '@/lib/config';
import { ManualTradePanel } from '@/components/ManualTradePanel';

/**
 * Embeds the ONLINE terminal (apps/frontend, with the TV Charting Library) in an
 * iframe for the chart + analysis, and puts a NATIVE manual-trade panel beside
 * it. The panel places/manages orders edge-side against the user's own exchange
 * via the local api — no server signal. The TV charting library is served from
 * the online origin and never bundled into this app (licence boundary).
 */
export default function Terminal() {
  const { iframeRef } = useTerminalBridge();
  const [params] = useSearchParams();

  // Prefill from ?symbol=BTCUSDT&exchange=binance (e.g. Markets drill-through):
  // the online terminal deep-links via ?symbol=EXCHANGE:SYMBOL.
  const terminalSrc = useMemo(() => {
    const symbol = params.get('symbol');
    if (!symbol) return ONLINE_TERMINAL_URL;
    const exchange = params.get('exchange');
    const pair =
      symbol.includes(':') || !exchange ? symbol : `${exchange.toUpperCase()}:${symbol}`;
    try {
      const url = new URL(ONLINE_TERMINAL_URL);
      url.searchParams.set('symbol', pair);
      return url.toString();
    } catch {
      return ONLINE_TERMINAL_URL;
    }
  }, [params]);

  return (
    <div className="flex h-full flex-col text-foreground">
      <PageHeader
        title="Chart"
        description="Chart and analysis from KaiBot Studio. Place and manage manual trades locally on your own exchange."
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-md border border-border">
          <iframe
            ref={iframeRef}
            src={terminalSrc}
            title="KaiBot Studio chart"
            className="h-full w-full"
            // The embedded terminal needs scripts + same-origin for its own auth;
            // it cannot reach Tauri APIs (gated by the capabilities remote allowlist).
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            allow="clipboard-read; clipboard-write"
          />
        </div>
        <aside className="w-full flex-shrink-0 overflow-hidden rounded-md border border-border lg:w-[340px]">
          <ManualTradePanel />
        </aside>
      </div>
    </div>
  );
}
