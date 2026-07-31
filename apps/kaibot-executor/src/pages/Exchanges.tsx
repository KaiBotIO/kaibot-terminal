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
        try {
          const [accountsRes, balancesRes, positionsRes] = await Promise.all([
            apiFetch(`/api/exchanges/v2/accounts/${exchangeName}`, {
              headers: { 'x-user-id': 'default' }
            }),
            apiFetch(`/api/exchanges/v2/balances/${exchangeName}`, {
              headers: { 'x-user-id': 'default' }
            }),
            apiFetch(`/api/exchanges/v2/positions/${exchangeName}`, {
              headers: { 'x-user-id': 'default' }
            })
          ])
          if (accountsRes.ok && balancesRes.ok) {
            accounts.set(exchangeName, await accountsRes.json())
            balances.set(exchangeName, await balancesRes.json())
          }
          if (positionsRes.ok) {
            positions.set(exchangeName, await positionsRes.json())
          }
        } catch (error) {
          console.error(`Failed to fetch data for ${exchangeName}:`, error)
        }
      }),
  )

  return { sessions, accounts, balances, positions }
}

export default function Exchanges() {
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

  const handleConnect = async (exchangeName: string, credentials: any) => {
    const response = await apiFetch(`/api/exchanges/v2/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': 'default'
      },
      body: JSON.stringify({ exchangeName, credentials })
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

  const handleDisconnect = async (exchangeName: string) => {
    const ok = await confirm({
      title: `Disconnect ${exchangeName}?`,
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
        body: JSON.stringify({ exchangeName })
      })

      if (response.ok) {
        // Optimistic removal; the next poll confirms the server state.
        setSessions(prev => prev.filter(s => s.exchangeName !== exchangeName))
        setBalances(prev => {
          const newMap = new Map(prev)
          newMap.delete(exchangeName)
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

  const getExchangeStats = (exchangeName: string) => {
    const exchangeAccounts = accounts.get(exchangeName) || []
    const exchangeBalances = balances.get(exchangeName) || []
    const exchangePositions = positions.get(exchangeName) || []

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

    // Calculate margin percentages
    const marginPercentages: Record<string, { im: number; mm: number }> = {}
    Object.entries(balancesByCurrency).forEach(([currency, totals]) => {
      if (totals.equity > 0) {
        marginPercentages[currency] = {
          im: (totals.initialMargin / totals.equity) * 100,
          mm: (totals.maintenanceMargin / totals.equity) * 100
        }
      } else {
        marginPercentages[currency] = { im: 0, mm: 0 }
      }
    })

    return {
      accountCount: exchangeAccounts.length,
      positionCount: exchangePositions.length,
      balancesByCurrency,
      marginPercentages,
      currencies: Object.keys(balancesByCurrency)
    }
  }

  // Portfolio totals across every connected venue. Sum the per-currency USD
  // value via the same notional figures the cards already use; guard against
  // sessions whose balances haven't loaded yet so the strip never reads NaN.
  const portfolio = connectedSessions.reduce(
    (acc, session) => {
      const stats = getExchangeStats(session.exchangeName)
      for (const totals of Object.values(stats.balancesByCurrency)) {
        acc.equity += Number.isFinite(totals.equity) ? totals.equity : 0
        acc.balance += Number.isFinite(totals.balance) ? totals.balance : 0
      }
      acc.positions += stats.positionCount
      const healthy = Object.values(stats.marginPercentages).every((m) => m.mm < 10)
      if (!healthy) acc.allHealthy = false
      return acc
    },
    { equity: 0, balance: 0, positions: 0, allHealthy: true },
  )

  return (
    <div className="flex flex-col text-foreground">
      <PageHeader
        title="Exchange Connections"
        description="Exchanges the executor can place orders on, with live equity and margin per account."
        actions={
          <Button size="sm" variant="outline" onClick={() => setIsConnectionDialogOpen(true)}>
            <Plus className="mr-1.5 size-3.5" />
            Add exchange
          </Button>
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
            description="Connect an exchange with a trade-only API key so your subscriptions can place orders on it."
            action={
              <Button onClick={() => setIsConnectionDialogOpen(true)}>
                <Plus className="mr-1.5 size-3.5" />
                Connect your first exchange
              </Button>
            }
          />
        </Section>
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Connected venues", value: connectedSessions.length, icon: Link2 },
              { label: "Total equity", value: `$${portfolio.equity.toFixed(2)}`, focal: true },
              { label: "Total balance", value: `$${portfolio.balance.toFixed(2)}` },
              { label: "Open positions", value: portfolio.positions },
              {
                label: "Health",
                value: portfolio.allHealthy ? "All healthy" : "Check margin",
                valueClassName: portfolio.allHealthy ? "text-[var(--kb-green)]" : "text-[var(--kb-amber)]",
              },
            ]}
          />

          <Section label="Connected venues" flush noBorder>
            <DataMatrix
              rows={connectedSessions}
              rowKey={(s) => s.exchangeName}
              onRowClick={(s) => navigate(`/exchanges/${s.exchangeName}`)}
              columns={[
                {
                  key: "venue",
                  header: "Venue",
                  cell: (session) => {
                    const stats = getExchangeStats(session.exchangeName)
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
                  cell: (session) => {
                    const stats = getExchangeStats(session.exchangeName)
                    return (
                      <div className="space-y-0.5 font-mono">
                        {stats.currencies.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          stats.currencies.map((currency) => (
                            <div key={currency}>
                              <CryptoAmount
                                amount={stats.balancesByCurrency[currency].equity}
                                currency={currency}
                                prices={session.prices}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    )
                  },
                },
                {
                  key: "balance",
                  header: "Balance",
                  align: "right",
                  cell: (session) => {
                    const stats = getExchangeStats(session.exchangeName)
                    return (
                      <div className="space-y-0.5 font-mono">
                        {stats.currencies.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          stats.currencies.map((currency) => (
                            <div key={currency}>
                              <CryptoAmount
                                amount={stats.balancesByCurrency[currency].balance}
                                currency={currency}
                                prices={session.prices}
                              />
                            </div>
                          ))
                        )}
                      </div>
                    )
                  },
                },
                {
                  key: "positions",
                  header: "Open pos",
                  align: "right",
                  cell: (session) => {
                    const stats = getExchangeStats(session.exchangeName)
                    return <span className="font-mono">{stats.positionCount}</span>
                  },
                },
                {
                  key: "margin",
                  header: "Margin health",
                  cell: (session) => {
                    const stats = getExchangeStats(session.exchangeName)
                    const allHealthy = Object.values(stats.marginPercentages).every((m) => m.mm < 10)
                    const color = allHealthy ? 'var(--kb-green)' : 'var(--kb-amber)'
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
                        <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
                          {allHealthy ? 'All healthy' : 'Check margin'}
                        </span>
                      </span>
                    )
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
                {
                  key: "actions",
                  header: "",
                  align: "right",
                  cell: (session) => (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Disconnect ${session.exchangeName}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDisconnect(session.exchangeName)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  ),
                },
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
