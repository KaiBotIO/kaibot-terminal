import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MatrixColumn } from '@kaibot/shared';
import { StrategyStatusTable } from '@/components/StrategyStatusTable';
import type { ScorecardSummary, StrategyScorecard } from '@/components/StrategyScorecard';

const summary = (netPnl: number): ScorecardSummary =>
  ({ hasData: true, totalTrades: 1, netPnl } as unknown as ScorecardSummary);

const card = (
  key: string,
  status: StrategyScorecard['status'],
  netPnl: number,
  openExecutions = 0,
): StrategyScorecard => ({
  key,
  strategy: key,
  signalBotId: key,
  summary: summary(netPnl),
  curve: [],
  firstTradeAt: 0,
  lastTradeAt: 0,
  status,
  statusSince: null,
  openExecutions,
});

const net: MatrixColumn<StrategyScorecard> = {
  key: 'net',
  header: 'Net',
  sortable: true,
  sortAccessor: (c) => c.summary.netPnl,
  cell: (c) => <span>{c.summary.netPnl}</span>,
};

const rows = [
  card('stopped-best', 'stopped', 500),
  card('running-low', 'running', 10),
  card('paused-mid', 'paused', 200),
  card('running-high', 'running', 100),
  card('gone', 'unknown', 50),
];

const strategyOrder = () =>
  screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td')?.textContent);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('StrategyStatusTable', () => {
  it('defaults to active only and shows the active/total count', () => {
    render(<StrategyStatusTable rows={rows} metricColumns={[net]} />);
    expect(strategyOrder()).toEqual(['running-high', 'running-low']);
    expect(screen.getByText(/2 active \/ 5 total/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Active only/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('chip off shows inactive rows below the active ones, muted, sorted within', () => {
    render(<StrategyStatusTable rows={rows} metricColumns={[net]} />);
    fireEvent.click(screen.getByRole('button', { name: /Active only/ }));
    expect(strategyOrder()).toEqual(['running-high', 'running-low', 'stopped-best', 'paused-mid', 'gone']);
    const muted = screen.getAllByRole('row').slice(1).map((r) => r.className.includes('opacity-55'));
    expect(muted).toEqual([false, false, true, true, true]);
    expect(localStorage.getItem('kaibot-executor-analytics-active-only')).toBe('0');
  });

  it('reads the chip state back from localStorage', () => {
    localStorage.setItem('kaibot-executor-analytics-active-only', '0');
    render(<StrategyStatusTable rows={rows} metricColumns={[net]} />);
    expect(strategyOrder()).toHaveLength(5);
  });

  it('renders the badge text per status', () => {
    localStorage.setItem('kaibot-executor-analytics-active-only', '0');
    render(<StrategyStatusTable rows={rows} metricColumns={[net]} />);
    for (const s of ['running', 'paused', 'stopped', 'unknown']) expect(screen.getAllByText(s).length).toBeGreaterThan(0);
    expect(screen.getAllByText('running')).toHaveLength(2);
  });

  it('stopped with open position stays visible under Active only', () => {
    render(
      <StrategyStatusTable
        rows={[card('running-a', 'running', 10), card('stopped-open', 'stopped', 300, 1), card('stopped-flat', 'stopped', 50)]}
        metricColumns={[net]}
      />,
    );
    expect(strategyOrder()).toEqual(['running-a', 'stopped-open']);
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText(/1 active \/ 3 total/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Active only/ }).textContent).toContain('2');
  });
});
