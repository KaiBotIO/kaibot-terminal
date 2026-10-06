// The Positions page header figures, derived from the exact rows the list
// renders so the count, notional and P&L can't drift from what is on screen.

import type { Position } from "@/lib/atoms";
import type { GroupedPosition, GroupOverviewEntry } from "@/lib/position-groups-api";
import { notionalOf } from "@/lib/notional";
import { sumPnlUsd } from "@/lib/portfolio-figures";

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
  };
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

export function positionsKpis(rows: Position[]): PositionsKpis {
  const { pnl, complete } = sumPnlUsd(rows);
  return {
    openPositions: rows.length,
    totalNotional: rows.reduce((sum, p) => sum + notionalOf(p), 0),
    unrealizedPnL: pnl,
    pnlComplete: complete,
  };
}
