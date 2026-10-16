// The Positions page header figures, derived from the exact rows the list
// renders so the count, notional and P&L can't drift from what is on screen.

import type { Position } from "@/lib/atoms";
import type { GroupedPosition, GroupOverviewEntry } from "@/lib/position-groups-api";
import { isInverseContract } from "@kaibot/types/core";
import { notionalOf } from "@/lib/notional";
import { fmtUsd, sumPnlUsd } from "@/lib/portfolio-figures";

export interface PositionsKpis {
  openPositions: number;
  totalNotional: number;
  unrealizedPnL: number;
  pnlComplete: boolean;
}

// Overview row → the Position shape the shared handlers/columns work on.
export function toPosition(gp: GroupedPosition): Position {
  return {
    id: gp.positionKey,
    accountId: gp.accountId,
    symbol: gp.symbol,
    side: gp.side,
    size: gp.size,
    entryPrice: gp.entryPrice,
    markPrice: gp.markPrice,
    unrealizedPnL: gp.unrealizedPnL,
    unrealizedPnLUsd: gp.unrealizedPnLUsd,
    pnlCurrency: gp.pnlCurrency,
    exchange: gp.exchange,
    group: gp.group,
    expiry: gp.expiry,
    ladder: gp.ladder,
    ride: gp.ride ?? null,
    synthetic: gp.synthetic ?? null,
    leg: gp.leg ?? null,
  };
}

/** First reason a group close can't run safely (a member netted inside a floor hedge); null when it can. */
export function groupCloseBlock(entry: GroupOverviewEntry): string | null {
  return entry.positions.find((p) => p.closeBlockedReason)?.closeBlockedReason ?? null;
}

/** Rows the list shows: the grouped overview once loaded, else the broker snapshot. */
export function listedPositions(entries: GroupOverviewEntry[] | null, snapshot: Position[]): Position[] {
  if (entries == null) return snapshot;
  return entries.flatMap((e) => e.positions.map(toPosition));
}

/** Connection label in a namespaced account id ("acct1/eth" → "acct1"); null on the default connection. */
export function accountKeyOfId(accountId: string | null | undefined): string | null {
  const i = accountId?.indexOf("/") ?? -1;
  return i > 0 ? accountId!.slice(0, i) : null;
}

/**
 * Notional the venues actually carry: a position split into hedge and bots'
 * legs counts once, at its net size. The legs keep their gross size per row.
 */
export function netNotional(rows: Position[]): number {
  const seen = new Set<string>();
  let sum = 0;
  for (const p of rows) {
    if (!p.leg) {
      sum += notionalOf(p);
      continue;
    }
    const key = `${p.exchange}|${p.accountId}|${p.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sum += notionalOf({ ...p, size: Math.abs(p.leg.venueNet), notional: undefined });
  }
  return sum;
}

export function positionsKpis(rows: Position[]): PositionsKpis {
  const { pnl, complete } = sumPnlUsd(rows);
  return {
    openPositions: rows.length,
    totalNotional: netNotional(rows),
    unrealizedPnL: pnl,
    pnlComplete: complete,
  };
}

/**
 * Second line under a row's size: "≈ $502" at mark, or "USD" on an inverse
 * contract where the size already is the notional. Same notionalOf as the
 * Total Notional card, so the rows add up to it. null when it can't be valued.
 */
export function sizeNotionalLabel(p: Parameters<typeof notionalOf>[0]): string | null {
  if (isInverseContract(p.exchange, p.symbol)) return "USD";
  const notional = notionalOf(p);
  return notional > 0 ? `≈ ${fmtUsd(notional, true, 0)}` : null;
}
