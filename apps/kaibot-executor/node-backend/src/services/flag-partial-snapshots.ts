// Repair for balance-snapshot ticks written before migration 042 flagged
// partial samples: a tick that lacks an account which has rows both shortly
// before and shortly after it (the TradeStation token outage of 19-20/09 left
// 220 Deribit-only ticks that drew the curve to ~$20). Such ticks get
// `partial` = 1 so the curve shows a gap; nothing is deleted. Idempotent:
// already-flagged ticks are skipped, so a rerun reports zero.
//
// Window: an account absent for longer than `windowMs` on both sides is taken
// as disconnected on purpose, not as a failed poll.

import type { KaiBotDatabase } from '../storage/database.js'

export const DEFAULT_PARTIAL_WINDOW_MS = 48 * 60 * 60 * 1000

export interface PartialTick {
  ts: number
  missing: string[]
}

export interface FlagPartialReport {
  dryRun: boolean
  ticks: number
  alreadyFlagged: number
  // Rows updated (0 on a dry run).
  updated: number
  from: string | null
  to: string | null
  sample: PartialTick[]
}

export function findPartialTicks(
  ticks: Array<{ ts: number; accounts: string; partial: number }>,
  windowMs = DEFAULT_PARTIAL_WINDOW_MS,
): { toFlag: PartialTick[]; alreadyFlagged: number } {
  const ordered = [...ticks].sort((a, b) => a.ts - b.ts)
  const seenAt = new Map<string, number[]>() // account -> tick indexes
  ordered.forEach((t, i) => {
    for (const acct of t.accounts.split(',').filter(Boolean)) {
      const list = seenAt.get(acct) ?? []
      list.push(i)
      seenAt.set(acct, list)
    }
  })
  const missingByIndex = new Map<number, Set<string>>()
  for (const [acct, idxs] of seenAt) {
    for (let k = 1; k < idxs.length; k++) {
      const prev = idxs[k - 1]
      const next = idxs[k]
      if (next - prev <= 1) continue
      if (ordered[next].ts - ordered[prev].ts > windowMs) continue
      for (let i = prev + 1; i < next; i++) {
        const set = missingByIndex.get(i) ?? new Set<string>()
        set.add(acct)
        missingByIndex.set(i, set)
      }
    }
  }
  const toFlag: PartialTick[] = []
  let alreadyFlagged = 0
  for (const [i, missing] of [...missingByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (ordered[i].partial > 0) {
      alreadyFlagged++
      continue
    }
    toFlag.push({ ts: ordered[i].ts, missing: [...missing].sort() })
  }
  return { toFlag, alreadyFlagged }
}

export function flagPartialSnapshots(
  db: Pick<KaiBotDatabase, 'listSnapshotTicks' | 'markSnapshotTicksPartial'>,
  opts: { dryRun?: boolean; windowMs?: number } = {},
): FlagPartialReport {
  const dryRun = opts.dryRun !== false
  const { toFlag, alreadyFlagged } = findPartialTicks(db.listSnapshotTicks(), opts.windowMs)
  const updated = dryRun || toFlag.length === 0 ? 0 : db.markSnapshotTicksPartial(toFlag.map((t) => t.ts))
  return {
    dryRun,
    ticks: toFlag.length,
    alreadyFlagged,
    updated,
    from: toFlag.length ? new Date(toFlag[0].ts).toISOString() : null,
    to: toFlag.length ? new Date(toFlag[toFlag.length - 1].ts).toISOString() : null,
    sample: toFlag.slice(0, 50),
  }
}
