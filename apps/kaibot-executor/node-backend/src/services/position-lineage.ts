// Which lineage holds a live position: a bot (subscription) or the user's own
// hand. The Chart page's positions list used to badge from the bot list keyed
// on (exchange, symbol) — bots carry the root ('MES'), positions the dated
// contract ('MESU26'), so every bot position showed as MANUAL. The book is the
// source: an open execution on (exchange, account, symbol) whose entry signal
// names a bot is that bot's position; a manual marker (or nothing) is manual.

export interface LineageExecution {
  signal_id: string
  exchange: string
  symbol: string
  account_id: string | null
  direction: 'long' | 'short'
  status: string
  qty_opened: number
  qty_closed: number
}

export interface PositionLineage {
  exchange: string
  accountId: string | null
  symbol: string
  /** 'bot' when at least one open execution belongs to a bot; else 'manual'. */
  source: 'bot' | 'manual'
  signalBotId: string | null
  botName: string | null
  /** Net open quantity held by the bot lineage on this (exchange, account, symbol). */
  botQty: number
}

export interface LineageLookups {
  /** signalBotId carried by the entry signal's metadata, if any. */
  signalBotIdFor(signalId: string): string | null
  /** Display name of the subscription/bot, if known. */
  botNameFor(signalBotId: string): string | null
}

export function derivePositionLineage(
  executions: LineageExecution[],
  manual: Array<{ exchange: string; account_id: string; symbol: string }>,
  lookups: LineageLookups,
): PositionLineage[] {
  const byKey = new Map<string, PositionLineage>()
  const key = (exchange: string, accountId: string | null, symbol: string) =>
    `${exchange}|${accountId ?? ''}|${symbol.toUpperCase()}`

  for (const e of executions) {
    if (e.status !== 'open' && e.status !== 'closing') continue
    const open = Math.max(0, e.qty_opened - e.qty_closed)
    if (open <= 0) continue
    const botId = lookups.signalBotIdFor(e.signal_id)
    const k = key(e.exchange, e.account_id, e.symbol)
    const cur = byKey.get(k) ?? {
      exchange: e.exchange,
      accountId: e.account_id,
      symbol: e.symbol,
      source: 'manual' as const,
      signalBotId: null,
      botName: null,
      botQty: 0,
    }
    if (botId) {
      cur.source = 'bot'
      cur.botQty += open
      // First bot wins the label; a second bot on the same pair is rare and
      // the list shows one badge per position anyway.
      if (!cur.signalBotId) {
        cur.signalBotId = botId
        cur.botName = lookups.botNameFor(botId)
      }
    }
    byKey.set(k, cur)
  }

  for (const m of manual) {
    const k = key(m.exchange, m.account_id, m.symbol)
    if (!byKey.has(k)) {
      byKey.set(k, {
        exchange: m.exchange,
        accountId: m.account_id,
        symbol: m.symbol,
        source: 'manual',
        signalBotId: null,
        botName: null,
        botQty: 0,
      })
    }
  }
  return [...byKey.values()]
}
