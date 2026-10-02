// The numbers on the Portfolio page and the Dashboard strip, derived from the
// broker snapshot (sessions, balances per connection, positions). Pure so the
// composition can be tested with mocked venues.
//
// Everything is USD: a coin wallet counts at the mark the backend attached
// (usdEquity), a wallet without one is left out and flips `equityComplete`;
// notional and P&L go through the shared per-contract rules (notional.ts).

import type { Balance, ExchangeSession, Position } from "@/lib/atoms";
import { connectionLabel, sessionKey } from "@/lib/connection";
import { isUsdLike, usdTotals } from "@/lib/exchange-stats";
import { notionalOf, pnlUsdOf } from "@/lib/notional";

export interface PortfolioExchangeRow {
  key: string;
  exchange: string;
  /** USD equity of the connection (floor when `equityComplete` is false). */
  equity: number;
  equityComplete: boolean;
  /** Coin wallets in their own units ("0.1 BTC · 5.01 ETH"); empty for dollar-only accounts. */
  wallets: string;
  /** USD notional of the open positions on this connection. */
  exposure: number;
  unrealizedPnL: number;
  pnlComplete: boolean;
  positions: number;
}

export interface PortfolioFigures {
  totalEquity: number;
  equityComplete: boolean;
  unrealizedPnL: number;
  pnlComplete: boolean;
  openPositions: number;
  totalNotional: number;
  allocation: Array<{ symbol: string; notional: number }>;
  connectedCount: number;
  sessionCount: number;
  exchanges: PortfolioExchangeRow[];
}

export function fmtCoin(amount: number): string {
  const abs = Math.abs(amount);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return amount.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** "0.1 BTC · 5.01 ETH" for the coin wallets of a connection (dollar wallets are the USD figure already). */
export function walletSummary(balances: Balance[]): string {
  return balances
    .filter((b) => !isUsdLike(b.currency) && (b.equity || 0) !== 0)
    .map((b) => `${fmtCoin(b.equity)} ${(b.currency || "").toUpperCase()}`)
    .join(" · ");
}

function onConnection(p: Position, s: ExchangeSession): boolean {
  return p.exchange === s.exchangeName && (p.accountKey ?? null) === (s.accountKey ?? null);
}

export function sumPnlUsd(positions: Position[]): { pnl: number; complete: boolean } {
  let pnl = 0;
  let complete = true;
  for (const p of positions) {
    const v = pnlUsdOf(p);
    if (v == null) complete = false;
    else pnl += v;
  }
  return { pnl, complete };
}

export function allocationOf(positions: Position[]): Array<{ symbol: string; notional: number }> {
  const bySymbol = new Map<string, number>();
  for (const p of positions) {
    const notional = notionalOf(p);
    if (notional <= 0) continue;
    bySymbol.set(p.symbol, (bySymbol.get(p.symbol) ?? 0) + notional);
  }
  return Array.from(bySymbol.entries())
    .map(([symbol, notional]) => ({ symbol, notional }))
    .sort((a, b) => b.notional - a.notional);
}

export function portfolioFigures(input: {
  sessions: ExchangeSession[];
  balances: Map<string, Balance[]>;
  positions: Position[];
}): PortfolioFigures {
  const { sessions, balances, positions } = input;
  const connected = sessions.filter((s) => s.status === "connected");

  const exchanges: PortfolioExchangeRow[] = connected
    .map((s) => {
      const wallets = balances.get(sessionKey(s)) ?? [];
      const usd = usdTotals(wallets);
      const own = positions.filter((p) => onConnection(p, s));
      const { pnl, complete } = sumPnlUsd(own);
      return {
        key: sessionKey(s),
        exchange: connectionLabel(s),
        equity: usd.equity,
        equityComplete: usd.complete,
        wallets: walletSummary(wallets),
        exposure: own.reduce((sum, p) => sum + notionalOf(p), 0),
        unrealizedPnL: pnl,
        pnlComplete: complete,
        positions: own.length,
      };
    })
    .sort((a, b) => b.equity - a.equity);

  const allWallets = Array.from(balances.values()).flat();
  const total = usdTotals(allWallets);
  const totalPnl = sumPnlUsd(positions);
  const allocation = allocationOf(positions);

  return {
    totalEquity: total.equity,
    equityComplete: total.complete,
    unrealizedPnL: totalPnl.pnl,
    pnlComplete: totalPnl.complete,
    openPositions: positions.length,
    totalNotional: allocation.reduce((sum, a) => sum + a.notional, 0),
    allocation,
    connectedCount: connected.length,
    sessionCount: sessions.length,
    exchanges,
  };
}

/** "$1,234.56", with "≥ " in front when the figure is a floor. */
export function fmtUsd(value: number, complete = true, digits = 2): string {
  const s = `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  return complete ? s : `≥ ${s}`;
}

/** "+$12.34" / "-$12.34", with "≥ " when a coin P&L could not be valued. */
export function fmtSignedUsd(value: number, complete = true): string {
  const s = `${value >= 0 ? "+" : "-"}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return complete ? s : `${s} +?`;
}
