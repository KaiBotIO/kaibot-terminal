import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Badge, DataMatrix, EmptyState, PageHeader, Section, StatStrip, useConfirm } from '@kaibot/shared'
import { AlertTriangle, Plus, Trash2, Link2 } from '@/lib/icons'
import { ExchangeSelectionWizard } from '../components/exchanges/ExchangeSelectionWizard'
import { apiFetch } from '@/lib/api';
import { CryptoAmount } from '@/components/CryptoAmount'
import { useAtomValue, useSetAtom } from 'jotai'
import { exchangeSessionsAtom, balancesAtom } from '@/lib/atoms'
import { usePolledResource } from '@/hooks/usePolledResource'
import { useIsViewer } from '@/hooks/useRole'
import { accountQuery, connectionLabel, sessionKey } from '@/lib/connection'
import {
  MARGIN_LABEL,
  accountMargin,
  countOpenPositions,
  isUsdLike,
  usdTotals,
  worstMarginState,
  type AccountMargin,
  type MarginState,
} from '@/lib/exchange-stats'


interface ExchangeAccount {
  exchangeName: string
  accountId: string
  name: string
  currency: string
}

interface ExchangesSnapshot {
  sessions: any[]
  accounts: Map<string, ExchangeAccount[]>
  balances: Map<string, any[]>
  positions: Map<string, any[]>
}

async function fetchExchangesSnapshot(): Promise<ExchangesSnapshot> {
  const response = await apiFetch(`/api/exchanges/v2/sessions`, {
    headers: { 'x-user-id': 'default' }
  })
  if (!response.ok) throw new Error('Failed to fetch sessions')
  const sessions = await response.json()

  const accounts = new Map<string, ExchangeAccount[]>()
  const balances = new Map<string, any[]>()
  const positions = new Map<string, any[]>()

  await Promise.all(
    sessions
      .filter((s: any) => s.status === 'connected')
      .map(async (session: any) => {
        const exchangeName = session.exchangeName
        // One row per CONNECTION: `?account=` scopes each call to it.
        const key = sessionKey(session)
        const q = accountQuery(session)
        try {
          const [accountsRes, balancesRes, positionsRes] = await Promise.all([
            apiFetch(`/api/exchanges/v2/accounts/${exchangeName}${q}`, {
              headers: { 'x-user-id': 'default' }
            }),
            apiFetch(`/api/exchanges/v2/balances/${exchangeName}${q}`, {
              headers: { 'x-user-id': 'default' }
            }),
            apiFetch(`/api/exchanges/v2/positions/${exchangeName}${q}`, {
              headers: { 'x-user-id': 'default' }
            })
          ])
          if (accountsRes.ok && balancesRes.ok) {
            accounts.set(key, await accountsRes.json())
            balances.set(key, await balancesRes.json())
          }
          if (positionsRes.ok) {
            positions.set(key, await positionsRes.json())
          }
        } catch (error) {
          console.error(`Failed to fetch data for ${connectionLabel(session)}:`, error)
        }
      }),
  )

  return { sessions, accounts, balances, positions }
}

// USD value beside a coin amount. Silent for a dollar wallet (the number is
// already the USD figure) and for a coin the venue could not price.
function UsdBeside({ value, currency }: { value: number | null; currency: string }) {
  if (value == null || isUsdLike(currency)) return null
  return (
    <span className="text-[10px] text-muted-foreground">
      ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
    </span>
  )
}

const MARGIN_COLOR: Record<MarginState, string> = {
  healthy: 'var(--kb-green)',
  tight: 'var(--kb-amber)',
  unknown: 'hsl(var(--muted-foreground))',
}

// The state plus the numbers it was decided on, per account. Without them
// "Check margin" was a verdict with no evidence.
function MarginCell({ state, margins }: { state: MarginState; margins: AccountMargin[] }) {
  const color = MARGIN_COLOR[state]
  const detail = margins.length
    ? margins
        .map((m) =>
          m.state === 'unknown'
            ? `${m.accountId}: no margin data`
            : `${m.accountId}: free ${fmtAmount(m.free)} vs floor ${fmtAmount(m.floor)} ${m.currency} (used ${fmtAmount(m.used)})`,
        )
        .join('\n')
    : undefined
  return (
    <span className="inline-flex items-center gap-1.5" title={detail}>
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
      <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
        {MARGIN_LABEL[state]}
      </span>
    </span>
  )
}

const fmtAmount = (n: number | null) =>
  n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function Exchanges() {
  const isViewer = useIsViewer()
  const navigate = useNavigate()
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false)
  const sessions = useAtomValue(exchangeSessionsAtom)
  const balances = useAtomValue(balancesAtom)
  const setSessions = useSetAtom(exchangeSessionsAtom)
  const setBalances = useSetAtom(balancesAtom)

  // Poll every 30s — live brokers rate-limit aggressive polling.
  const { data, error, isLoading, refresh } = usePolledResource(
    fetchExchangesSnapshot,
    { intervalMs: 30000 },
  )
  const accounts = data?.accounts ?? new Map<string, ExchangeAccount[]>()
  const positions = data?.positions ?? new Map<string, any[]>()

  useEffect(() => {
    if (!data) return
    setSessions(data.sessions)
    setBalances(data.balances)
  }, [data, setSessions, setBalances])

  const handleConnect = async (exchangeName: string, credentials: any, label?: string) => {
    const response = await apiFetch(`/api/exchanges/v2/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'default'
      },
      body: JSON.stringify({ exchangeName, credentials, ...(label ? { label } : {}) })
    })

    const data = await response.json()

    // Check if OAuth is required
    if (data.requiresOAuth && data.authUrl) {
      // Return the OAuth data so the wizard can handle it
      throw { message: 'OAUTH_REDIRECT_REQUIRED', authUrl: data.authUrl }
    }

    if (!response.ok) {
      throw new Error(data.error || 'Failed to connect')
    }

    await refresh()
  }

  const { confirm, dialog: confirmDialog } = useConfirm()

  const handleDisconnect = async (session: { exchangeName: string; accountKey?: string | null; label?: string }) => {
    const exchangeName = session.exchangeName
    const label = session.accountKey ?? undefined
    const key = sessionKey(session)
    const ok = await confirm({
      title: `Disconnect ${connectionLabel(session)}?`,
      description:
        'Removes the stored credentials from this executor. Open positions on the exchange stay as they are.',
      tone: 'destructive',
      confirmLabel: 'Disconnect',
    })
    if (!ok) return
    try {
      const response = await apiFetch(`/api/exchanges/v2/disconnect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': 'default'
        },
        body: JSON.stringify({ exchangeName, ...(label ? { label } : {}) })
      })

      if (response.ok) {
        // Optimistic removal; the next poll confirms the server state.
        setSessions(prev => prev.filter(s => sessionKey(s) !== key))
        setBalances(prev => {
          const newMap = new Map(prev)
          newMap.delete(key)
          return newMap
        })
        refresh()
      }
    } catch (error) {
      console.error('Failed to disconnect:', error)
    }
  }

  const connectedSessions = sessions.filter(s => s.status === 'connected')
  const hasConnectedExchanges = connectedSessions.length > 0

  const getExchangeStats = (session: { exchangeName: string; accountKey?: string | null; label?: string }) => {
    const key = sessionKey(session)
    const exchangeAccounts = accounts.get(key) || []
    const exchangeBalances = balances.get(key) || []
    const exchangePositions = positions.get(key) || []

    // Group balances by currency
    const balancesByCurrency: Record<string, {
      balance: number
      equity: number
      realizedPnL: number
      unrealizedPnL: number
      initialMargin: number
      maintenanceMargin: number
    }> = {}

    exchangeBalances.forEach(balance => {
      const currency = balance.currency || 'USD'
      if (!balancesByCurrency[currency]) {
        balancesByCurrency[currency] = {
          balance: 0,
          equity: 0,
          realizedPnL: 0,
          unrealizedPnL: 0,
          initialMargin: 0,
          maintenanceMargin: 0
        }
      }
      balancesByCurrency[currency].balance += balance.balance
      balancesByCurrency[currency].equity += balance.equity
      balancesByCurrency[currency].realizedPnL += balance.realizedPnL
      balancesByCurrency[currency].unrealizedPnL += balance.unrealizedPnL
      balancesByCurrency[currency].initialMargin += balance.initialMargin || 0
      balancesByCurrency[currency].maintenanceMargin += balance.maintenanceMargin || 0
    })

    // USD value per wallet currency, from the marks the backend attached.
    const usdByCurrency: Record<string, { equity: number | null; balance: number | null }> = {}
    for (const b of exchangeBalances) {
      const currency = b.currency || 'USD'
      const cur = usdByCurrency[currency] ?? { equity: 0, balance: 0 }
      cur.equity = cur.equity == null || b.usdEquity == null ? null : cur.equity + b.usdEquity
      cur.balance = cur.balance == null || b.usdBalance == null ? null : cur.balance + b.usdBalance
      usdByCurrency[currency] = cur
    }

    // Margin per ACCOUNT, on the breathing-room guard's own terms (free margin
    // against the floor), not an invented percentage of equity.
    const margins = exchangeBalances.map((b) => accountMargin(b))

    return {
      accountCount: exchangeAccounts.length,
      positionCount: countOpenPositions(exchangePositions),
      balancesByCurrency,
      usd: usdTotals(exchangeBalances),
      usdByCurrency,
      margins,
      marginState: worstMarginState(margins.map((m) => m.state)),
      currencies: Object.keys(balancesByCurrency)
    }
  }

  // Portfolio totals across every connected venue, in USD. A coin wallet counts
  // at the venue mark the backend attached; a wallet it could not price is left
  // out and flags the total as a floor rather than silently shrinking it.
  const portfolio = connectedSessions.reduce(
    (acc, session) => {
      const stats = getExchangeStats(session)
      acc.equity += stats.usd.equity
      acc.balance += stats.usd.balance
      if (!stats.usd.complete) acc.complete = false
      acc.positions += stats.positionCount
      acc.marginStates.push(stats.marginState)
      return acc
    },
    { equity: 0, balance: 0, positions: 0, complete: true, marginStates: [] as MarginState[] },
  )
  const marginState = worstMarginState(portfolio.marginStates)

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Exchange Connections"
        description="Exchanges the executor can place orders on, with live equity and margin per account."
        actions={
          isViewer ? undefined : (
            <Button size="sm" variant="outline" onClick={() => setIsConnectionDialogOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Add exchange
            </Button>
          )
        }
      />

      {isLoading && !data ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          Loading exchanges…
        </div>
      ) : error != null ? (
        <Section flush noBorder>
          <EmptyState
            className="py-10"
            icon={AlertTriangle}
            title="Couldn't load exchanges"
            description="The executor backend didn't respond. Your exchange connections are unchanged."
            action={<Button onClick={refresh}>Retry</Button>}
          />
        </Section>
      ) : !hasConnectedExchanges ? (
        <Section flush noBorder>
          <EmptyState
            icon={Link2}
            title="No exchanges connected"
            description={isViewer ? "The admin has not connected an exchange yet." : "Connect an exchange with a trade-only API key so your subscriptions can place orders on it."}
            action={
              isViewer ? undefined : (
                <Button onClick={() => setIsConnectionDialogOpen(true)}>
                  <Plus className="mr-1.5 size-3.5" />
                  Connect your first exchange
                </Button>
              )
            }
          />
        </Section>
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Connected venues", value: connectedSessions.length, icon: Link2 },
              {
                label: "Total equity",
                value: `${portfolio.complete ? "" : "≥ "}$${portfolio.equity.toFixed(2)}`,
                focal: true,
                caption: portfolio.complete ? "USD, coin at venue mark" : "a wallet has no mark yet",
                hint: "Every wallet in USD: dollar balances as they are, coin balances at the venue's own mark. A coin the venue could not price is left out and the total shows as a floor.",
              },
              {
                label: "Total balance",
                value: `${portfolio.complete ? "" : "≥ "}$${portfolio.balance.toFixed(2)}`,
                hint: "Wallet balance in USD, before unrealized P&L. Equity is this plus what open positions are currently worth.",
              },
              {
                label: "Open positions",
                value: portfolio.positions,
                hint: "Positions actually holding size. A venue that lists every instrument it has ever traded reports the flat ones at size 0; those are not counted.",
              },
              {
                label: "Margin health",
                value: MARGIN_LABEL[marginState],
                valueClassName:
                  marginState === "tight"
                    ? "text-[var(--kb-amber)]"
                    : marginState === "unknown"
                      ? "text-muted-foreground"
                      : "text-[var(--kb-green)]",
                hint: "Free margin (equity minus initial margin) against the breathing-room floor (the account's maintenance margin). Below floor means a new open would be refused. No margin data means the venue reported none, which is normal outside trading hours.",
              },
            ]}
          />

          <Section label="Connected venues" flush noBorder>
            <DataMatrix
              rows={connectedSessions}
              rowKey={(s) => sessionKey(s)}
              onRowClick={(s) => navigate(`/exchanges/${s.exchangeName}${accountQuery(s)}`)}
              columns={[
                {
                  key: "venue",
                  header: "Venue",
                  cell: (session) => {
                    const stats = getExchangeStats(session)
                    const dot =
                      session.status === 'connected'
                        ? 'var(--kb-green)'
                        : session.error
                          ? 'var(--kb-red)'
                          : 'hsl(var(--muted-foreground))'
                    return (
                      <span className="inline-flex items-center gap-2">
                        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
                        <span className="font-mono capitalize text-[var(--kb-teal)]">{session.exchangeName}</span>
                        {session.accountKey && (
                          <Badge variant="outline" className="font-mono text-[10px]">{session.accountKey}</Badge>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {stats.accountCount} {stats.accountCount === 1 ? 'acct' : 'accts'}
                        </span>
                      </span>
                    )
                  },
                },
                {
                  key: "equity",
                  header: "Equity",
                  align: "right",
                  hint: "Per wallet currency, with the USD value at the venue mark beside it.",
                  cell: (session) => {
                    const stats = getExchangeStats(session)
                    return (
                      <div className="space-y-0.5 font-mono">
                        {stats.currencies.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          stats.currencies.map((currency) => (
                            <div key={currency} className="flex items-baseline justify-end gap-2">
                              <CryptoAmount
                                amount={stats.balancesByCurrency[currency].equity}
                                currency={currency}
                                prices={session.prices}
                              />
                              <UsdBeside value={stats.usdByCurrency[currency]?.equity ?? null} currency={currency} />
                            </div>
                          ))
                        )}
                        {stats.currencies.length > 1 && (
                          <div className="border-t border-border/60 pt-0.5 text-[10px] text-muted-foreground">
                            {stats.usd.complete ? "" : "≥ "}${stats.usd.equity.toFixed(2)}
                          </div>
                        )}
                      </div>
                    )
                  },
                },
                {
                  key: "balance",
                  header: "Balance",
                  align: "right",
                  hint: "Per wallet currency, with the USD value at the venue mark beside it.",
                  cell: (session) => {
                    const stats = getExchangeStats(session)
                    return (
                      <div className="space-y-0.5 font-mono">
                        {stats.currencies.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          stats.currencies.map((currency) => (
                            <div key={currency} className="flex items-baseline justify-end gap-2">
                              <CryptoAmount
                                amount={stats.balancesByCurrency[currency].balance}
                                currency={currency}
                                prices={session.prices}
                              />
                              <UsdBeside value={stats.usdByCurrency[currency]?.balance ?? null} currency={currency} />
                            </div>
                          ))
                        )}
                        {stats.currencies.length > 1 && (
                          <div className="border-t border-border/60 pt-0.5 text-[10px] text-muted-foreground">
                            {stats.usd.complete ? "" : "≥ "}${stats.usd.balance.toFixed(2)}
                          </div>
                        )}
                      </div>
                    )
                  },
                },
                {
                  key: "positions",
                  header: "Open pos",
                  align: "right",
                  hint: "Positions holding size. Instruments the venue still lists at size 0 are flat, not open.",
                  cell: (session) => {
                    const stats = getExchangeStats(session)
                    return <span className="font-mono">{stats.positionCount}</span>
                  },
                },
                {
                  key: "margin",
                  header: "Margin health",
                  hint: "Free margin (equity minus initial margin) against the breathing-room floor (maintenance margin). Hover a row for the numbers per account.",
                  cell: (session) => {
                    const stats = getExchangeStats(session)
                    return <MarginCell state={stats.marginState} margins={stats.margins} />
                  },
                },
                {
                  key: "status",
                  header: "Status",
                  cell: (session) => (
                    <Badge variant={session.status === 'connected' ? 'success' : 'error'}>
                      {session.status === 'connected' ? 'connected' : 'disconnected'}
                    </Badge>
                  ),
                },
                ...(isViewer ? [] : [{
                  key: "actions",
                  header: "",
                  align: "right" as const,
                  cell: (session: any) => (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Disconnect ${connectionLabel(session)}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDisconnect(session)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ),
                }]),
              ]}
            />
          </Section>
        </>
      )}

      <ExchangeSelectionWizard
        open={isConnectionDialogOpen}
        onOpenChange={setIsConnectionDialogOpen}
        onConnect={handleConnect}
      />
      {confirmDialog}
    </div>
  )
}
