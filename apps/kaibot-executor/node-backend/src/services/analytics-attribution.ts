// Who each closed execution belongs to, for the Analytics by-strategy rows.
//
// The rule is lineage: a trade counts for a bot only when the signal behind it
// names that bot. Position groups are keyed on (exchange, account, symbol), so
// resolving on the group alone made every post that touched a contract inherit
// whichever bot holds it. That is how the two reconciler round-trips of
// 2026-09-01 (`reconcile-roundtrip:<orderId>`, same account and symbol as the
// live Ascender MGC long) ended up inside that bot's scorecard.

import type { KaiBotDatabase } from '../storage/database.js'
import { groupRowForPosition } from './position-groups.js'
import { resolveStrategyLabel, type StrategyLabel } from './analytics.js'

export interface AttributableExecution {
  signal_id: string
  symbol: string
  exchange: string
  account_id: string | null
}

/** signal_id -> label. A missing key means unattributed. */
export function buildStrategyLabels(
  db: KaiBotDatabase,
  execs: AttributableExecution[],
): Map<string, StrategyLabel> {
  const configsBySymbol = new Map<string, { name: string; signalBotId: string }>()
  const configsByBotId = new Map<string, { name: string }>()
  for (const cfg of db.getBotConfigs(false)) {
    const name = cfg.strategyName ?? cfg.botName ?? cfg.signalBotId
    const key = `${cfg.exchange.toLowerCase()}|${cfg.symbol.toUpperCase()}`
    if (!configsBySymbol.has(key)) configsBySymbol.set(key, { name, signalBotId: cfg.signalBotId })
    if (!configsByBotId.has(cfg.signalBotId)) configsByBotId.set(cfg.signalBotId, { name })
  }

  // Presence in `signals` IS the lineage test: a manual order or a synthetic
  // repair post has no row here.
  const signalRows = db.all(
    `SELECT id,
            COALESCE(json_extract(metadata, '$.signalBotId'),
                     json_extract(metadata, '$.signal_bot_id')) AS bot_id
       FROM signals`,
    [],
  ) as Array<{ id: string; bot_id: string | null }>
  const botIdBySignal = new Map<string, string | null>(signalRows.map((r) => [r.id, r.bot_id]))

  const out = new Map<string, StrategyLabel>()
  for (const e of execs) {
    const group =
      e.account_id != null ? groupRowForPosition(db, e.exchange, e.account_id, e.symbol) : null
    const botId = botIdBySignal.get(e.signal_id) ?? null
    const label = resolveStrategyLabel({
      signalBotId: botId,
      fromSignal: botIdBySignal.has(e.signal_id),
      group: group ? { name: group.name, signalBotId: group.signal_bot_id } : null,
      configForBot: (botId ? configsByBotId.get(botId) : undefined) ?? null,
      configForSymbol:
        configsBySymbol.get(`${e.exchange.toLowerCase()}|${e.symbol.toUpperCase()}`) ?? null,
    })
    if (label) out.set(e.signal_id, label)
  }
  return out
}
