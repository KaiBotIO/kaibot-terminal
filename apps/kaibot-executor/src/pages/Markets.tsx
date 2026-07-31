import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { DataFreshness, DataMatrix, EmptyState, PageHeader, QueryStateGate, Section, StatStrip } from "@kaibot/shared";
import { CandlestickChart, Coins, RefreshCw } from "lucide-react";
import { opsApi } from "@/lib/ops-api";
import { usePolledResource } from "@/hooks/usePolledResource";

const fmt = (n: number | null) =>
  n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export default function Markets() {
  const navigate = useNavigate();
  const { data, error, isLoading: loading, lastUpdated, refresh } = usePolledResource(
    opsApi.markets,
    { intervalMs: 3000 },
  );

  const futures = data?.futures ?? [];
  const crypto = data?.crypto ?? [];

  const sessionsOpen = useMemo(() => futures.filter((m) => m.open).length, [futures]);
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const m of futures) set.add(m.exchange);
    for (const m of crypto) set.add(m.exchange);
    return set.size;
  }, [futures, crypto]);

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Markets"
        description="Front-month futures contracts and active crypto markets from your connected venues."
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
              description="Connect an exchange to see its tradeable markets and live prices here."
            />
          </Section>
        }
      >
        <>
          <StatStrip
            items={[
              { label: "Futures Tracked", value: futures.length },
              { label: "Crypto Markets", value: crypto.length },
              { label: "Sessions Open", value: sessionsOpen },
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
            >
              <DataMatrix
                rows={crypto}
                rowKey={(m, i) => `${m.exchange}:${m.symbol}:${i}`}
                defaultSort={{ key: "market", dir: "asc" }}
                onRowClick={(m) =>
                  navigate(
                    `/terminal?symbol=${encodeURIComponent(m.symbol)}&exchange=${encodeURIComponent(m.exchange)}`,
                  )
                }
                columns={[
                  {
                    key: "exchange",
                    header: "Exchange",
                    sortable: true,
                    sortAccessor: (m) => m.exchange,
                    cell: (m) => (
                      <span className="font-mono text-[10px] uppercase text-muted-foreground">
                        {m.exchange}
                      </span>
                    ),
                  },
                  {
                    key: "market",
                    header: "Market",
                    sortable: true,
                    sortAccessor: (m) => m.symbol,
                    cell: (m) => (
                      <span className="font-mono text-[var(--kb-teal)]">{m.symbol}</span>
                    ),
                  },
                  {
                    key: "last",
                    header: "Last",
                    align: "right",
                    sortable: true,
                    sortAccessor: (m) => m.last,
                    cell: (m) => <span className="font-mono">{fmt(m.last)}</span>,
                  },
                ]}
              />
            </Section>
          )}
        </>
      </QueryStateGate>
      )}
    </div>
  );
}
