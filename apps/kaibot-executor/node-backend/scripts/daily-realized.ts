// Today's (UTC) daily-loss figure as the guardrail computes it, per execution.
// Run on a COPY of a Terminal DB: opening it runs migrations.
//   bun scripts/daily-realized.ts /path/to/copy.db
import { KaiBotDatabase } from '../src/storage/database.js'
import { contractKindOf, realizedPnlTodayUtc, utcDayStartMs } from '../src/services/daily-pnl.js'
import { computeSignalPnl } from '../src/services/pnl.js'

const path = process.argv[2]
if (!path) throw new Error('usage: bun scripts/daily-realized.ts <db-copy>')
const db = new KaiBotDatabase(path)
const since = utcDayStartMs()
const execs = db.all(
  `SELECT signal_id, symbol, direction, status, exchange FROM signal_executions
   WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 500`,
  [since],
) as any[]
for (const e of execs) {
  const fills = db.getSignalFills(e.signal_id)
  const exits = fills.filter((f) => f.kind === 'exit')
  if (exits.length === 0 || Math.max(...exits.map((f) => f.created_at)) < since) continue
  const kind = contractKindOf(e.exchange, e.symbol)
  const pnl = computeSignalPnl(e, fills)
  console.log(
    [e.signal_id, e.exchange, e.symbol, e.direction, kind ?? 'SKIPPED', pnl.realizedNet.toFixed(2), exits.some((f) => f.price == null) ? 'exit-without-price' : ''].join('\t'),
  )
}
console.log(`realizedPnlTodayUtc = ${realizedPnlTodayUtc(db).toFixed(2)}`)
