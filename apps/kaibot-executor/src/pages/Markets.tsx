import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Badge, DataFreshness, EmptyState, PageHeader, QueryStateGate, Section, StatStrip } from "@kaibot/shared";
import { CandlestickChart, Coins, RefreshCw } from "lucide-react";
import { opsApi, type CryptoMarketSource } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmt = (n: number | null) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

// Funding is a fraction per interval; basis points read better than 0.000042.
const fmtFunding = (rate: number) => `${(rate * 10_000).toFixed(2)} bp`;

const SOURCE_LABEL: Record<CryptoMarketSource, string> = {
  subscription: "subscribed",
  synthetic: "synthetic",
  position: "position",
};

export default function Markets() {
  const navigate = useNavigate();
  const { data, error, isLoading: loading, lastUpdated, refresh } = usePolledResource(
    opsApi.markets,
    { intervalMs: 3000 },
  );

  const futures = data?.futures ?? [];
  const crypto = data?.crypto ?? [];

  // A venue counts as open when a futures contract of it trades right now, or
  // when it is a crypto connection (those never close).
  const sessionsOpen = useMemo(() => {
    const set = new Set<string>();
    for (const m of futures) if (m.open) set.add(m.exchange);
    for (const m of crypto) set.add(m.connection);
    return set.size;
  }, [futures, crypto]);
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const m of futures) set.add(m.exchange);
    for (const m of crypto) set.add(m.connection);
    return set.size;
  }, [futures, crypto]);

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Markets"
        description="Front-month futures contracts and the crypto markets your connections watch, per venue."
        actions={
          <DataFreshness
            updatedAt={lastUpdated}
            isRefreshing={loading}
            onRefresh={refresh}
          />
        }
      />

      {loading && !data ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
      <QueryStateGate
        isLoading={false}
        isError={error != null}
        onRetry={refresh}
        errorTitle="Couldn't load markets"
        isEmpty={futures.length === 0 && crypto.length === 0}
        emptyState={
          <Section flush noBorder>
            <EmptyState
              icon={CandlestickChart}
              title="No markets to show"
              description="Connect an exchange, or subscribe a bot to a market, to see live prices here."
            />
          </Section>
        }
      >
        <>
          <StatStrip
            items={[
              { label: "Futures Tracked", value: futures.length },
              {
                label: "Crypto Markets",
                value: crypto.length,
                hint: "Markets a connection is watching: subscribed to, holding a synthetic USD row, or holding a position. A flat book still has markets.",
              },
              {
                label: "Sessions Open",
                value: sessionsOpen,
                hint: "Venues trading right now. Futures venues follow their session hours; crypto connections never close.",
              },
              { label: "Venues", value: venues },
            ]}
          />

          {futures.length > 0 && (
            <Section
              flush
              noBorder={crypto.length === 0}
              label={
                <span className="flex items-center gap-1.5">
                  <CandlestickChart className="size-3.5 text-muted-foreground" />
                  Futures
                </span>
              }
            >
              <div className="grid border-t border-l border-border sm:grid-cols-2 lg:grid-cols-4">
                {futures.map((m) => (
                  <div
                    key={`${m.exchange}:${m.root}`}
                    className="border-r border-b border-border px-5 py-4"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.label}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.root}
                      </span>
                    </div>
                    <div className="mt-2 font-mono text-[28px] font-medium leading-none tabular-nums">
                      {fmt(m.last)}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span
                        className={`size-1.5 rounded-full ${m.open ? "bg-[var(--kb-green)]" : "bg-muted-foreground/40"}`}
                      />
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.symbol ?? "front month resolving…"} · {m.open ? "open" : "closed"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {crypto.length > 0 && (
            <Section
              flush
              noBorder
              label={
                <span className="flex items-center gap-1.5">
                  <Coins className="size-3.5 text-muted-foreground" />
                  Crypto
                </span>
              }
              meta={`${crypto.length} market${crypto.length === 1 ? "" : "s"} watched`}
            >
              <div className="grid border-t border-l border-border sm:grid-cols-2 lg:grid-cols-4">
                {crypto.map((m) => (
                  <button
                    type="button"
                    key={`${m.connection}:${m.symbol}`}
                    onClick={() =>
                      navigate(
                        `/terminal?symbol=${encodeURIComponent(m.symbol)}&exchange=${encodeURIComponent(m.exchange)}`,
                      )
                    }
                    className="border-r border-b border-border px-5 py-4 text-left transition-colors hover:bg-muted/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {m.connection}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--kb-teal)]">
                        {m.symbol}
                      </span>
                    </div>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className="font-mono text-[28px] font-medium leading-none tabular-nums">
                        {fmt(m.last)}
                      </span>
                      {m.change24hPct != null && (
                        <span
                          className={`font-mono text-[11px] tabular-nums ${
                            m.change24hPct >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"
                          }`}
                        >
                          {m.change24hPct >= 0 ? "+" : ""}
                          {m.change24hPct.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-[var(--kb-green)]" />
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        open 24/7
                        {m.fundingRate != null && ` · funding ${fmtFunding(m.fundingRate)}`}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {m.position ? (
                        <Badge
                          variant={m.position.side === "short" ? "error" : "success"}
                          className="text-[9px]"
                        >
                          {m.position.side ?? "flat"} {m.position.size}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] text-muted-foreground">
                          flat
                        </Badge>
                      )}
                      {m.sources
                        .filter((src) => src !== "position")
                        .map((src) => (
                          <Badge key={src} variant="secondary" className="text-[9px]">
                            {SOURCE_LABEL[src]}
                          </Badge>
                        ))}
                    </div>
                  </button>
                ))}
              </div>
            </Section>
          )}
        </>
      </QueryStateGate>
      )}
    </div>
  );
}
