import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, PageHeader } from '@kaibot/shared';
import { useTerminalBridge } from '@/hooks/useTerminalBridge';
import { ONLINE_TERMINAL_URL } from '@/lib/config';
import { studioApi } from '@/lib/ops-api';
import { openExternalUrl } from '@/lib/utils';
import { ManualTradePanel } from '@/components/ManualTradePanel';

/**
 * Embeds the ONLINE terminal (apps/frontend, with the TV Charting Library) in an
 * iframe for the chart + analysis, and puts a NATIVE manual-trade panel beside
 * it. The panel places/manages orders edge-side against the user's own exchange
 * via the local api — no server signal. The TV charting library is served from
 * the online origin and never bundled into this app (licence boundary).
 *
 * Sign-in inside the frame: Studio's session cookie is SameSite=Lax, so from
 * this (cross-site) page the iframe would land on Studio's sign-in. The local
 * backend trades its API pairing for a single-use verify URL; loading that URL
 * signs the frame in and redirects to the chart (docs/executor/
 * studio-embed-handoff.md). When that fails the frame loads Studio as-is and an
 * "Open in Studio" button offers the same page in a normal tab.
 */
type EmbedState = { status: 'loading' } | { status: 'ready'; src: string } | { status: 'fallback'; src: string };

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

  const [embed, setEmbed] = useState<EmbedState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setEmbed({ status: 'loading' });
    studioApi
      .embedToken()
      .then(({ verifyUrl }) => {
        if (cancelled) return;
        const url = new URL(verifyUrl);
        url.searchParams.set('callbackURL', terminalSrc);
        setEmbed({ status: 'ready', src: url.toString() });
      })
      .catch(() => {
        if (!cancelled) setEmbed({ status: 'fallback', src: terminalSrc });
      });
    return () => {
      cancelled = true;
    };
  }, [terminalSrc]);

  return (
    <div className="flex h-full flex-col text-foreground">
      <PageHeader
        title="Chart"
        description="Chart and analysis from KaiBot Studio. Place and manage manual trades locally on your own exchange."
        actions={
          <Button variant="outline" size="sm" onClick={() => openExternalUrl(terminalSrc)}>
            Open in Studio
          </Button>
        }
      />
      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-md border border-border">
          {embed.status === 'fallback' && (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Could not sign the embedded chart in. Sign in inside the frame, or open Studio in a tab.
              </span>
              <Button variant="outline" size="sm" onClick={() => openExternalUrl(terminalSrc)}>
                Open in Studio
              </Button>
            </div>
          )}
          {embed.status !== 'loading' && (
            <iframe
              ref={iframeRef}
              src={embed.src}
              title="KaiBot Studio chart"
              className="h-full w-full"
              // The embedded terminal needs scripts + same-origin for its own auth;
              // it cannot reach Tauri APIs (gated by the capabilities remote allowlist).
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              allow="clipboard-read; clipboard-write"
            />
          )}
        </div>
        <aside className="w-full flex-shrink-0 overflow-hidden rounded-md border border-border lg:w-[340px]">
          <ManualTradePanel />
        </aside>
      </div>
    </div>
  );
}
