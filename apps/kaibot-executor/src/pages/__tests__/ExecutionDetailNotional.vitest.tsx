import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import type { ExecutionDetail as ExecutionDetailPayload } from '@/lib/ops-api';

// Notional under the qty comes from the backend's cached mark; without one the
// line stays away instead of guessing at entry.

const execution = vi.fn<() => Promise<ExecutionDetailPayload>>();
vi.mock('@/lib/ops-api', () => ({ opsApi: { execution: () => execution() } }));

import ExecutionDetail from '@/pages/ExecutionDetail';

const payload = (markPrice: number | null): ExecutionDetailPayload => ({
  signal: null,
  subscription: null,
  clips: [],
  queue: [],
  execution: {
    signal_id: 'sig-mgc', symbol: 'MGCZ26', exchange: 'tradestation', account_id: '21084931',
    direction: 'long', status: 'open', qty_opened: 1, qty_closed: 0, error_reason: null,
    created_at: 0, updated_at: 0,
  },
  fills: [],
  settlements: [],
  bracket: null,
  pnl: {
    entryAvg: 4102.3, exitAvg: null, qtyOpened: 1, qtyClosed: 0, realizedPnl: 0, realizedNet: 0,
    commission: 0, unrealizedPnl: null, multiplier: 10,
  },
  markPrice,
  markAt: markPrice == null ? null : Date.now(),
});

function renderPage() {
  return render(
    <Provider store={createStore()}>
      <MemoryRouter initialEntries={['/activity/sig-mgc']}>
        <Routes>
          <Route path="/activity/:signalId" element={<ExecutionDetail />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

describe('execution detail notional', () => {
  afterEach(() => cleanup());

  it('values the open qty at the backend mark', async () => {
    execution.mockResolvedValue(payload(4138.7));
    renderPage();
    expect(await screen.findByText('≈ $41,387')).toBeInTheDocument();
  });

  it('shows no notional without a mark', async () => {
    execution.mockResolvedValue(payload(null));
    renderPage();
    expect(await screen.findByText('1 / 0')).toBeInTheDocument();
    expect(screen.queryByText(/≈ \$/)).not.toBeInTheDocument();
  });
});
