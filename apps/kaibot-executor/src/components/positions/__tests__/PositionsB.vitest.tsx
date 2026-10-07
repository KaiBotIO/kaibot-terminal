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
  it('marks the binding layer and keeps the others behind it', () => {
    const pr = deriveProtection(btc, {
      ...EMPTY_SOURCES,
      rides: [ride],
      hedges: [{ exchange: 'deribit', accountId: 'btc', symbol: 'BTC-PERPETUAL', status: 'armed', triggerPrice: 76_000, lastError: null } as never],
    });
    const { container } = render(<ProtectionBadges protection={pr} />);
    const primary = container.querySelector('[data-primary="true"]');
    expect(primary).toHaveTextContent('ride stop 79,227');
    expect(container.querySelector('[data-kind="hedge"]')).toHaveTextContent('hedge 76,000');
    expect(screen.queryByText('no stop')).toBeNull();
  });

  it('says "no stop" when nothing protects the position', () => {
    render(<ProtectionBadges protection={deriveProtection(btc, EMPTY_SOURCES)} />);
    expect(screen.getByText('no stop')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /Fault-Line ETH 4h/ }));
    expect(onChange).toHaveBeenCalledWith('g1');
  });
});

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
    expect(await screen.findByText(/ride stop 79,227/, undefined, { timeout: 20_000 })).toBeInTheDocument();
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
