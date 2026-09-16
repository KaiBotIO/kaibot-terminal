// Active ride hand-overs as the rest of the executor reads them (position
// enrichment, group overview). DB-only: no service imports, so any module can
// use it without a cycle.

import type { KaiBotDatabase } from '../storage/database.js'

export const HANDOVER_SIGNAL_PREFIX = 'handover:'

export interface ActiveRide {
  positionId: string
  entrySignalId: string
  exchange: string
  symbol: string
  accountId: string | null
  direction: 'long' | 'short'
  botId: string | null
  botName: string | null
  currentStop: number | null
}

// Every position this executor handed to a ride bot and still manages
// server-side (active server_exit_state on a hand-over execution).
export function listActiveRides(db: KaiBotDatabase): ActiveRide[] {
  const out: ActiveRide[] = []
  for (const state of db.listActiveServerExitStates()) {
    const exec = db.getSignalExecution(state.entry_signal_id)
    if (!exec || (exec.status !== 'open' && exec.status !== 'closing')) continue
    const row = db.get('SELECT metadata FROM signals WHERE id = ?', [state.entry_signal_id]) as
      | { metadata: string | null }
      | undefined
    let meta: Record<string, unknown> = {}
    try {
      meta = row?.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {}
    } catch {
      meta = {}
    }
    // A ride is either the Terminal hand-over (synthetic entry) or a filled
    // entry the ride bot adopted (metadata.rideBotId, drawing trigger).
    const synthetic = state.entry_signal_id.startsWith(HANDOVER_SIGNAL_PREFIX)
    const adopted = typeof meta.rideBotId === 'string'
    if (!synthetic && !adopted) continue
    const botId = adopted
      ? (meta.rideBotId as string)
      : typeof meta.signalBotId === 'string'
        ? meta.signalBotId
        : null
    const sub = botId ? (db.getSubscription(botId) as { bot_name?: string | null } | undefined) : undefined
    out.push({
      positionId: state.position_id,
      entrySignalId: state.entry_signal_id,
      exchange: state.exchange,
      symbol: state.symbol,
      accountId: exec.account_id ?? null,
      direction: state.direction,
      botId,
      botName: sub?.bot_name ?? botId,
      currentStop: state.current_stop,
    })
  }
  return out
}

export function activeRideFor(
  db: KaiBotDatabase,
  exchange: string,
  accountId: string | null | undefined,
  symbol: string,
): ActiveRide | null {
  return (
    listActiveRides(db).find(
      (r) =>
        r.exchange === exchange &&
        r.symbol.toUpperCase() === symbol.toUpperCase() &&
        (r.accountId == null || accountId == null || r.accountId === accountId),
    ) ?? null
  )
}

