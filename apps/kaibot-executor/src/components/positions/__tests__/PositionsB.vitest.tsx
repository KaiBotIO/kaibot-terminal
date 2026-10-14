import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { sessionRoleAtom, type SessionRole } from '@/lib/atoms';
import { ProtectionBadges } from '@/components/positions/ProtectionBadges';
import { RowActionsMenu } from '@/components/positions/RowActionsMenu';
import { GroupFilterChips } from '@/components/positions/GroupFilterChips';
import { EMPTY_SOURCES, deriveProtection, groupFilterChips, rowActionIds } from '@/lib/position-protection';
import type { Position } from '@/lib/atoms';

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, isDesktop: () => false };
});

import Positions from '@/pages/Positions';

const btc: Position = {
  id: 'pos:deribit:btc:BTC-PERPETUAL',
  accountId: 'btc',
  symbol: 'BTC-PERPETUAL',
  side: 'long',
  size: 2950,
  entryPrice: 86_116.5,
  markPrice: 86_400,
  unrealizedPnL: 0,
  exchange: 'deribit',
};

const ride = {
  positionId: 'r1',
  exchange: 'deribit',
  symbol: 'BTC-PERPETUAL',
  accountId: 'btc',
  direction: 'long' as const,
  botId: 'b1',
  botName: 'ETH tf-ride 1h',
  currentStop: 79_227,
};

afterEach(cleanup);

describe('ProtectionBadges', () => {
  it('shows the ride stop as the bot stop, the hedge guard as a muted extra', () => {
    const pr = deriveProtection(btc, {
      ...EMPTY_SOURCES,
      rides: [ride],
      hedges: [{ exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', hedgeSymbol: 'BTC-PERPETUAL', status: 'armed', triggerPrice: 76_000, lastError: null } as never],
    });
    const { container } = render(<ProtectionBadges protection={pr} side="long" />);
    expect(container.querySelector('[data-kind="stop-bot"]')).toHaveTextContent('bot stop 79,227.00');
    expect(container.querySelector('[data-kind="hedge"]')).toHaveTextContent('hedge 76,000.00');
    expect(screen.queryByText('none')).toBeNull();
  });

  it('a plan floor is a dashed coin floor chip that opens the plan, not protection', () => {
    const floor = {
      id: 'f1', exchange: 'deribit', account_id: 'btc', symbol: 'BTC-PERPETUAL', status: 'armed',
      armed: { inCycle: true, coverManual: false, triggerPrice: 76_904.63, firedPrice: null, lastError: null },
    } as never;
    const plan = { id: '6fcc70de-17b1', exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', phase: 'waiting', ride: null, lastError: null } as never;
    const onOpenPlan = vi.fn();
    const { container } = render(
      <ProtectionBadges protection={deriveProtection(btc, { ...EMPTY_SOURCES, floors: [floor], plans: [plan] })} side="long" onOpenPlan={onOpenPlan} />,
    );
    expect(container.querySelector('[data-kind="stop-none"]')).toHaveTextContent('none');
    const chip = container.querySelector('[data-kind="coin-floor"]')!;
    expect(chip).toHaveTextContent('coin floor 76,904.63');
    expect(chip).toHaveAttribute('title', 'Accumulate plan 6fcc70de: sells the coin holdings below this price');
    expect(screen.queryByText(/plan/i)).toBeNull();
    fireEvent.click(chip);
    expect(onOpenPlan).toHaveBeenCalledWith('6fcc70de-17b1');
  });

  it('a synthetic USD short reads "synthetic hedge", muted, not "none"', () => {
    const short: Position = {
      ...btc, side: 'short',
      synthetic: { id: 's1', triggerPrice: 76_904, firedPrice: 76_800, firedAt: 1, shortUsd: 7_690, holdingsCoin: 0.1, holdingsUsd: 7_973 },
    };
    const { container } = render(<ProtectionBadges protection={deriveProtection(short, EMPTY_SOURCES)} side="short" />);
    expect(container.querySelector('[data-kind="synthetic-hedge"]')).toHaveTextContent('synthetic hedge');
    expect(screen.queryByText('none')).toBeNull();
  });

  it('says "none" when nothing protects the position', () => {
    render(<ProtectionBadges protection={deriveProtection(btc, EMPTY_SOURCES)} side="long" />);
    expect(screen.getByText('none')).toBeInTheDocument();
  });
});

describe('RowActionsMenu', () => {
  const handlers = { onAction: vi.fn(), onReduce: vi.fn(), onMove: vi.fn(), onNewGroup: vi.fn() };

  it('renders nothing for a viewer', () => {
    const ids = rowActionIds(btc, { isViewer: true, riding: false, hasPlan: false, canAccount: true });
    const { container } = render(
      <RowActionsMenu ids={ids} groups={[]} currentGroupId={null} handlers={handlers} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the actions of an admin row and runs the picked one', () => {
    const ids = rowActionIds(btc, { isViewer: false, riding: true, hasPlan: true, canAccount: true });
    render(<RowActionsMenu ids={ids} groups={[]} currentGroupId={null} handlers={handlers} defaultOpen />);
    const menu = screen.getByRole('menu');
    for (const label of ['Set stop…', 'Take back from the ride bot', 'Accumulate…', 'Plan: check now', 'Close at market']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
    expect(within(menu).queryByText('Hand over to a ride bot…')).toBeNull();
    fireEvent.click(within(menu).getByText('Close at market'));
    expect(handlers.onAction).toHaveBeenCalledWith('close');
  });
});

describe('GroupFilterChips', () => {
  it('switches the filter and has no Manual chip without manual rows', () => {
    const onChange = vi.fn();
    const chips = groupFilterChips([{ ...btc, group: { id: 'g1', name: 'Fault-Line ETH 4h', source: 'bot' } }]);
    render(<GroupFilterChips chips={chips} active="all" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /Manual/ })).toBeNull();
    const chip = screen.getByRole('button', { name: /Fault-Line ETH 4h/ });
    expect(chip).toHaveTextContent('Fault-Line ETH 4h · 1');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('g1');
  });
});

// The ride's server exit state: its venue order makes the stop count.
const rideExitState = {
  kind: 'floor', positionId: 'r1', entrySignalId: 'e1', exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL',
  direction: 'long', manualStop: null, trailingLock: false, engineStop: 79_227, currentStop: 79_227, slOrderId: 'sl-1',
  effectiveStop: 79_227, active: true, updatedAt: 1,
};

describe('Positions page by role', () => {
  beforeEach(() => {
    localStorage.clear();
    const overview = {
      entries: [
        {
          group: null,
          aggregates: { positionCount: 1, netUnrealizedPnl: 9.7, exposure: 2950, stopRisk: null, stoppedCount: 0 },
          positions: [
            {
              exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', side: 'long', size: 2950,
              entryPrice: 86_116.5, markPrice: 86_400, unrealizedPnL: 0, positionKey: btc.id, group: null,
              effectiveStop: null, expiry: null, ladder: null, ride: { positionId: 'r1', botId: 'b1', botName: 'ETH tf-ride 1h' },
              unrealizedPnLUsd: 9.71, pnlCurrency: 'BTC',
            },
          ],
        },
      ],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body =
        url.includes('/api/exchanges/v2/sessions') ? [] :
        url.includes('/api/position-groups/overview') ? overview :
        url.includes('/api/trade/handover/list') ? { rides: [ride] } :
        url.includes('/api/trade/manage') ? { trails: [], floors: [rideExitState], brackets: [] } :
        { positions: [], groups: [], trails: [], floors: [], hedges: [], plans: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  });

  function renderAs(role: SessionRole) {
    const store = createStore();
    store.set(sessionRoleAtom, role);
    return render(
      <Provider store={store}>
        <MemoryRouter>
          <Positions />
        </MemoryRouter>
      </Provider>,
    );
  }

  it('viewer: badges, no action menu', async () => {
    renderAs('viewer');
    expect(await screen.findByText(/bot stop 79,227/, undefined, { timeout: 20_000 })).toBeInTheDocument();
    expect(screen.getByText('Protected').parentElement?.parentElement).toHaveTextContent('1/1');
    expect(screen.queryByLabelText('Position actions')).toBeNull();
    expect(screen.queryByText('Close all')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open chart' })).toBeNull();
  }, 30_000);

  it('admin: one action menu per row, Manual chip for the ungrouped row', async () => {
    renderAs('admin');
    await waitFor(() => expect(screen.getAllByLabelText('Position actions')).toHaveLength(1), { timeout: 20_000 });
    expect(screen.getByRole('button', { name: /Manual/ })).toBeInTheDocument();
    expect(screen.queryByText('Unsorted')).toBeNull();
    const chartPath = '/terminal?symbol=BTC-PERPETUAL&exchange=deribit';
    expect(screen.getByRole('link', { name: 'Open chart' })).toHaveAttribute('href', chartPath);
    expect(screen.getByRole('link', { name: 'BTC-PERPETUAL' })).toHaveAttribute('href', chartPath);
  }, 30_000);
});

describe('Positions page: the fired synthetic short', () => {
  const synthetic = { id: 'syn-eth', triggerPrice: 2_471.2424, firedPrice: 2_460.79, firedAt: 1, shortUsd: 12_356, holdingsCoin: 5, holdingsUsd: 12_297.65 };
  beforeEach(() => {
    localStorage.clear();
    const overview = {
      entries: [{
        group: null,
        aggregates: { positionCount: 1, netUnrealizedPnl: 0, exposure: 12_356, stopRisk: null, stoppedCount: 0 },
        positions: [{
          exchange: 'deribit', accountId: 'eth', symbol: 'ETH-PERPETUAL', side: 'short', size: 12_356,
          entryPrice: 2_460.79, markPrice: 2_455, unrealizedPnL: 0, positionKey: 'pos:deribit:eth:ETH-PERPETUAL', group: null,
          effectiveStop: null, expiry: null, ladder: null, ride: null, synthetic, unrealizedPnLUsd: 29, pnlCurrency: 'ETH',
        }],
      }],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body =
        url.includes('/api/exchanges/v2/sessions') ? [] :
        url.includes('/api/position-groups/overview') ? overview :
        { positions: [], groups: [], trails: [], floors: [], hedges: [], plans: [], rides: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  });

  for (const role of ['viewer', 'admin'] as const) {
    it(`${role}: SYNTHETIC + trigger linking to Synthetic USD, HEDGE, no Manual chip`, async () => {
      const store = createStore();
      store.set(sessionRoleAtom, role);
      render(
        <Provider store={store}>
          <MemoryRouter>
            <Positions />
          </MemoryRouter>
        </Provider>,
      );
      const link = await screen.findByRole('link', { name: 'Synthetic USD · trigger 2,471' }, { timeout: 20_000 });
      expect(link).toHaveAttribute('href', '/synthetic-usd');
      expect(screen.getByText('synthetic')).toBeInTheDocument();
      expect(screen.getByText('synthetic hedge')).toBeInTheDocument();
      expect(screen.queryByText('none')).toBeNull();
      expect(screen.queryByRole('button', { name: /Manual/ })).toBeNull();
    }, 30_000);
  }
});
