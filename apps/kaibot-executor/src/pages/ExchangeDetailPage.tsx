import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ChevronLeft, RefreshCw } from '@/lib/icons'
import { Badge, Button, DataMatrix, PageHeader, Section, StaleDataBanner, StatStrip, Tabs, TabsContent, TabsList, TabsTrigger } from '@kaibot/shared'
import { formatCurrency, formatNumber } from '../lib/utils'
import { apiFetch } from '@/lib/api'
import { opsApi } from '@/lib/ops-api'
import { CryptoAmount } from '@/components/CryptoAmount'
import { AlertTriangle } from 'lucide-react'
import { usePolledResource } from '@/hooks/usePolledResource'

interface Account {
  id: string
  accountId: string
  accountType: string
  name: string
  currency: string
}

interface Balance {
  accountId: string
  balance: number
  equity: number
  realizedPnL: number
  unrealizedPnL: number
  initialMargin: number
  maintenanceMargin: number
  currency: string
}

interface Position {
  id: string
  accountId: string
  symbol: string
  side: 'long' | 'short'
  size: number
  entryPrice: number
  markPrice: number
  unrealizedPnL: number
  marginType: string
  leverage: number
}

interface ExchangeDetails {
  exchange: {
    name: string
    status: string
    lastRefresh: number
  }
  accounts: Account[]
  balances: Balance[]
  positions: Position[]
  prices?: Record<string, number>
}

async function fetchExchangeDetails(exchangeName: string): Promise<ExchangeDetails> {
  const response = await apiFetch(`/api/exchanges/v2/${exchangeName}/details`, {
    headers: { 'x-user-id': 'default' },
  })
  if (!response.ok) throw new Error('Failed to fetch exchange details')
  return response.json()
}

export default function ExchangeDetailPage() {
  // Key by exchange so navigating between exchanges resets the polled state.
  const { exchangeName } = useParams<{ exchangeName: string }>()
  return <ExchangeDetailInner key={exchangeName} exchangeName={exchangeName ?? ''} />
}

function ExchangeDetailInner({ exchangeName }: { exchangeName: string }) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState<'accounts' | 'positions'>('accounts')
  const [selectedAccount, setSelectedAccount] = useState<string>('all')
  const [refreshing, setRefreshing] = useState(false)

  // Poll every 30s — live brokers rate-limit aggressive polling. A failed poll
  // keeps the last snapshot and flags it stale instead of blanking the page.
  const { data: details, error, isStale, isLoading, lastUpdated, refresh } = usePolledResource(
    () => fetchExchangeDetails(exchangeName),
    { intervalMs: 30000 },
  )
  const loading = isLoading && !details

  // Poll reconciliation status for this exchange so the positions table can flag
  // symbols whose books drifted from the broker. Independent of the details poll
  // so a reconciliation fetch failure never blanks the page.
  const { data: recon } = usePolledResource(
    () => opsApi.reconciliations(exchangeName),
    { intervalMs: 5000 },
  )
  const mismatchedSymbols = useMemo(
    () => new Set((recon?.mismatched ?? []).map((r) => r.symbol)),
    [recon],
  )

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await apiFetch(`/api/exchanges/v2/${exchangeName}/refresh`, {
        method: 'POST',
        headers: { 'x-user-id': 'default' },
      })
    } catch {
      /* refresh() below surfaces a failure as stale data */
    }
    await refresh()
    setRefreshing(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <RefreshCw className="size-8 animate-spin mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">Loading exchange details…</p>
        </div>
      </div>
    )
  }

  if (error || !details) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-destructive mb-4">{error?.message || 'No data available'}</p>
          <div className="flex items-center justify-center gap-2">
            <Button onClick={() => void refresh()} variant="outline">
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
            <Button onClick={() => navigate('/exchanges')} variant="outline">
              <ChevronLeft className="mr-2 size-4" />
              Back to Exchanges
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Calculate totals by currency
  const balancesByCurrency = details.balances.reduce((acc, b) => {
    const currency = b.currency || 'USD'
    if (!acc[currency]) {
      acc[currency] = {
        equity: 0,
        balance: 0,
        unrealizedPnL: 0,
        initialMargin: 0,
        maintenanceMargin: 0
      }
    }
    acc[currency].equity += b.equity || 0
    acc[currency].balance += b.balance || 0
    acc[currency].unrealizedPnL += b.unrealizedPnL || 0
    acc[currency].initialMargin += b.initialMargin || 0
    acc[currency].maintenanceMargin += b.maintenanceMargin || 0
    return acc
  }, {} as Record<string, {
    equity: number;
    balance: number;
    unrealizedPnL: number;
    initialMargin: number;
    maintenanceMargin: number
  }>)

  // For display, we'll show the primary currency or indicate multiple currencies
  const currencies = Object.keys(balancesByCurrency)
  const hasSingleCurrency = currencies.length === 1
  const primaryCurrency = currencies[0] || 'USD'

  const allHealthy = Object.entries(balancesByCurrency).every(([, totals]) => {
    if (totals.equity <= 0) return true
    return (totals.maintenanceMargin / totals.equity) * 100 < 10
  })
  const totalUnrealized = Object.values(balancesByCurrency).reduce((sum, b) => sum + b.unrealizedPnL, 0)

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => navigate('/exchanges')}
        className="inline-flex items-center gap-1.5 px-6 pt-4 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" /> Exchanges
      </button>

      {isStale && <StaleDataBanner updatedAt={lastUpdated} onRetry={refresh} className="mx-6 mt-3" />}

      <PageHeader
        title={`${exchangeName} exchange`}
        meta={
          <div className="flex flex-col items-end gap-1.5">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: allHealthy ? 'var(--kb-green)' : 'var(--kb-amber)' }}
              />
              <span
                className="font-mono text-[10px] uppercase tracking-wider"
                style={{ color: allHealthy ? 'var(--kb-green)' : 'var(--kb-amber)' }}
              >
                {allHealthy ? 'All healthy' : 'Check margin'}
              </span>
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              Updated {new Date(details.exchange.lastRefresh).toLocaleString()}
            </span>
          </div>
        }
        actions={
          <Button
            onClick={handleRefresh}
            disabled={refreshing}
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
          >
            <RefreshCw className={`mr-1.5 h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      <StatStrip
        items={[
          {
            label: "Total equity",
            focal: true,
            value: hasSingleCurrency ? (
              <CryptoAmount amount={balancesByCurrency[primaryCurrency].equity} currency={primaryCurrency} prices={details.prices} />
            ) : (
              <div className="space-y-0.5 text-base">
                {Object.entries(balancesByCurrency).map(([currency, totals]) => (
                  <div key={currency}>
                    <CryptoAmount amount={totals.equity} currency={currency} prices={details.prices} />
                  </div>
                ))}
              </div>
            ),
          },
          {
            label: "Total balance",
            value: hasSingleCurrency ? (
              <CryptoAmount amount={balancesByCurrency[primaryCurrency].balance} currency={primaryCurrency} prices={details.prices} />
            ) : (
              <div className="space-y-0.5 text-base">
                {Object.entries(balancesByCurrency).map(([currency, totals]) => (
                  <div key={currency}>
                    <CryptoAmount amount={totals.balance} currency={currency} prices={details.prices} />
                  </div>
                ))}
              </div>
            ),
          },
          {
            label: "Unrealized PnL",
            valueClassName: totalUnrealized >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
            value: hasSingleCurrency ? (
              <CryptoAmount amount={balancesByCurrency[primaryCurrency].unrealizedPnL} currency={primaryCurrency} prices={details.prices} />
            ) : (
              <div className="space-y-0.5 text-base">
                {Object.entries(balancesByCurrency).map(([currency, totals]) => (
                  <div key={currency} className={totals.unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]"}>
                    <CryptoAmount amount={totals.unrealizedPnL} currency={currency} prices={details.prices} />
                  </div>
                ))}
              </div>
            ),
          },
          { label: "Active positions", value: details.positions.length },
        ]}
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'accounts' | 'positions')}
      >
        <Section flush bodyClassName="px-6 pt-3">
          <TabsList variant="line">
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="positions">Positions</TabsTrigger>
          </TabsList>
        </Section>

        <TabsContent value="accounts">
          <AccountsTab details={details} />
        </TabsContent>

        <TabsContent value="positions">
          <PositionsTab
            details={details}
            selectedAccount={selectedAccount}
            onSelectAccount={setSelectedAccount}
            mismatchedSymbols={mismatchedSymbols}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AccountsTab({ details }: { details: ExchangeDetails }) {
  return (
    <>
      {details.accounts.map((account) => {
        const balance = details.balances.find(b => b.accountId === account.accountId)
        return (
          <Section
            key={account.id}
            label={account.name}
            meta={`${account.accountType} · ${account.currency} · ${account.accountId}`}
            noBorder
          >
            {balance && (
              <>
                <StatStrip
                  size="sm"
                  items={[
                    {
                      label: "Balance",
                      value: <CryptoAmount amount={balance.balance} currency={balance.currency} prices={details.prices} />,
                    },
                    {
                      label: "Equity",
                      value: <CryptoAmount amount={balance.equity} currency={balance.currency} prices={details.prices} />,
                    },
                    {
                      label: "Unrealized PnL",
                      valueClassName: balance.unrealizedPnL >= 0 ? "text-[var(--kb-green)]" : "text-[var(--kb-red)]",
                      value: <CryptoAmount amount={balance.unrealizedPnL} currency={balance.currency} prices={details.prices} />,
                    },
                    {
                      label: "Initial Margin",
                      value: <CryptoAmount amount={balance.initialMargin} currency={balance.currency} prices={details.prices} />,
                    },
                  ]}
                />

                {/* Margin Progress Indicators */}
                {balance.equity > 0 && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Initial Margin Usage</span>
                        <span className={`text-[10px] font-mono font-medium ${
                          (balance.initialMargin / balance.equity) * 100 > 50 ? 'text-[var(--kb-amber)]' : 'text-[var(--kb-green)]'
                        }`}>
                          {((balance.initialMargin / balance.equity) * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full border border-border h-1.5">
                        <div
                          className={`h-1.5 transition-all ${
                            (balance.initialMargin / balance.equity) * 100 > 80 ? 'bg-[var(--kb-red)]' :
                            (balance.initialMargin / balance.equity) * 100 > 50 ? 'bg-[var(--kb-amber)]' :
                            'bg-[var(--kb-green)]'
                          }`}
                          style={{ width: `${Math.min((balance.initialMargin / balance.equity) * 100, 100)}%` }}
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-muted-foreground">Maintenance Margin Usage</span>
                        <span className={`text-[10px] font-mono font-medium ${
                          (balance.maintenanceMargin / balance.equity) * 100 > 30 ? 'text-[var(--kb-amber)]' : 'text-[var(--kb-green)]'
                        }`}>
                          {((balance.maintenanceMargin / balance.equity) * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="w-full border border-border h-1.5">
                        <div
                          className={`h-1.5 transition-all ${
                            (balance.maintenanceMargin / balance.equity) * 100 > 50 ? 'bg-[var(--kb-red)]' :
                            (balance.maintenanceMargin / balance.equity) * 100 > 30 ? 'bg-[var(--kb-amber)]' :
                            'bg-[var(--kb-green)]'
                          }`}
                          style={{ width: `${Math.min((balance.maintenanceMargin / balance.equity) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </Section>
        )
      })}
    </>
  )
}

function PositionsTab({
  details,
  selectedAccount,
  onSelectAccount,
  mismatchedSymbols,
}: {
  details: ExchangeDetails
  selectedAccount: string
  onSelectAccount: (accountId: string) => void
  mismatchedSymbols: Set<string>
}) {
  const filteredPositions = selectedAccount === 'all'
    ? details.positions
    : details.positions.filter(p => p.accountId === selectedAccount)

  return (
    <>
      <Section label="Open positions" flush noBorder
        actions={
          <div className="flex gap-0.5">
            <Button
              variant={selectedAccount === 'all' ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-[10px] uppercase"
              onClick={() => onSelectAccount('all')}
            >
              All
            </Button>
            {[...new Set(details.positions.map(p => p.accountId))].map(accountId => (
              <Button
                key={accountId}
                variant={selectedAccount === accountId ? 'default' : 'outline'}
                size="sm"
                onClick={() => onSelectAccount(accountId)}
                className="h-7 text-[10px] uppercase"
              >
                {accountId}
              </Button>
            ))}
          </div>
        }
      >
        <DataMatrix
          rows={filteredPositions}
          rowKey={(p) => p.id}
          empty={
            <p className="py-6 text-center text-[11px] text-muted-foreground">
              {selectedAccount === 'all'
                ? 'No open positions'
                : `No open positions in ${selectedAccount.toUpperCase()} account`}
            </p>
          }
          columns={[
            {
              key: "symbol",
              header: "Symbol",
              cell: (position) => (
                <span className="inline-flex items-center gap-1 font-mono font-medium text-[var(--kb-teal)]">
                  {position.symbol}
                  {mismatchedSymbols.has(position.symbol) && (
                    <Badge
                      variant="error"
                      className="gap-0.5 px-1 py-0 text-[9px]"
                      title="The latest reconciliation found a mismatch between our expected net and the broker net for this symbol."
                    >
                      <AlertTriangle className="size-2.5" />
                      mismatch
                    </Badge>
                  )}
                </span>
              ),
            },
            {
              key: "account",
              header: "Account",
              cell: (position) => (
                <span className="font-mono text-[10px] uppercase text-muted-foreground">{position.accountId}</span>
              ),
            },
            {
              key: "side",
              header: "Side",
              cell: (position) => (
                <Badge variant={position.side === 'long' ? 'success' : 'error'}>{position.side}</Badge>
              ),
            },
            { key: "size", header: "Size", align: "right", cell: (position) => <span className="font-mono">{formatNumber(position.size)}</span> },
            { key: "entry", header: "Entry", align: "right", cell: (position) => <span className="font-mono">{formatCurrency(position.entryPrice)}</span> },
            { key: "mark", header: "Mark", align: "right", cell: (position) => <span className="font-mono">{formatCurrency(position.markPrice)}</span> },
            {
              key: "pnl",
              header: "PnL",
              align: "right",
              cell: (position) => (
                <span className={`font-mono font-medium ${position.unrealizedPnL >= 0 ? 'text-[var(--kb-green)]' : 'text-[var(--kb-red)]'}`}>
                  {formatCurrency(position.unrealizedPnL)}
                </span>
              ),
            },
            { key: "lev", header: "Lev", align: "right", cell: (position) => <span className="font-mono">{position.leverage}x</span> },
          ]}
        />
      </Section>

      <p className="px-6 pb-4 text-[11px] text-muted-foreground">
        These are all open positions straight from the exchange, including positions that were not opened or managed by KaiBot.
      </p>
    </>
  )
}
