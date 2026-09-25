import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@kaibot/shared';
import { useTerminalBridge } from '@/hooks/useTerminalBridge';
import { buildTerminalSrc } from '@/lib/config';
import { studioApi } from '@/lib/ops-api';
import { openExternalUrl } from '@/lib/utils';
import { ManualTradePanel } from '@/components/ManualTradePanel';
import { useIsViewer } from '@/hooks/useRole';

/**
 * Embeds the ONLINE terminal (apps/frontend, with the TV Charting Library) in an
 * iframe for the chart + analysis, and puts a NATIVE manual-trade panel beside
 * it. The panel places/manages orders edge-side against the user's own exchange
 * via the local api — no server signal. The TV charting library is served from
 * the online origin and never bundled into this app (licence boundary).
 *
 * The frame loads Studio with `?embed=1`, which drops Studio's own sidebar and
 * topbar (apps/frontend/src/lib/embed-mode.ts) — this page already provides
 * both, and two sets of navigation left the chart in a corner. "Open in Studio"
 * opens the same chart WITHOUT that flag, so the tab gets the full app.
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
  const isViewer = useIsViewer();
  if (isViewer) return <ViewerNotice />;
  return <TerminalWorkspace />;
}

// The frame signs into Studio with the admin's pairing and the side panel
// places orders: neither exists for a viewer.
function ViewerNotice() {
  return (
    <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="font-heading text-[15px] font-semibold tracking-tight">Chart</h1>
      <p className="max-w-md text-xs text-muted-foreground">
        The chart and manual trading are not part of a view-only account. Positions, fills and analytics are.
      </p>
    </div>
  );
}

function TerminalWorkspace() {
  const { iframeRef } = useTerminalBridge();
  const [params] = useSearchParams();

  // Prefill from ?symbol=BTCUSDT&exchange=binance (e.g. Markets drill-through).
  const symbol = params.get('symbol');
  const exchange = params.get('exchange');
  // Studio pins its bridge listener to this origin (tauri://, loopback or LAN).
  const host = typeof window !== 'undefined' ? window.location.origin : null;
  const embedTarget = useMemo(
    () => buildTerminalSrc({ symbol, exchange, embed: true, host }),
    [symbol, exchange, host],
  );
  const studioUrl = useMemo(() => buildTerminalSrc({ symbol, exchange }), [symbol, exchange]);

  const [embed, setEmbed] = useState<EmbedState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setEmbed({ status: 'loading' });
    studioApi
      .embedToken()
      .then(({ verifyUrl }) => {
        if (cancelled) return;
        const url = new URL(verifyUrl);
        url.searchParams.set('callbackURL', embedTarget);
        setEmbed({ status: 'ready', src: url.toString() });
      })
      .catch(() => {
        if (!cancelled) setEmbed({ status: 'fallback', src: embedTarget });
      });
    return () => {
      cancelled = true;
    };
  }, [embedTarget]);

  return (
    <div className="flex h-full min-h-[520px] flex-col text-foreground">
      {/* Deliberately compact: every pixel here comes off the chart. */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="font-heading text-[15px] font-semibold tracking-tight">Chart</h1>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            Analysis from KaiBot Studio.
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={() => openExternalUrl(studioUrl)}>
          Open in Studio
        </Button>
      </div>
      <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-hidden p-3 lg:flex-row">
        <div className="relative min-h-[420px] flex-1 overflow-hidden rounded-md border border-border">
          {embed.status === 'fallback' && (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-background/95 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Could not sign the embedded chart in. Sign in inside the frame, or open Studio in a tab.
              </span>
              <Button variant="outline" size="sm" onClick={() => openExternalUrl(studioUrl)}>
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
        <aside className="w-full flex-shrink-0 overflow-y-auto rounded-md border border-border lg:w-[340px]">
          <ManualTradePanel />
        </aside>
      </div>
    </div>
  );
}
