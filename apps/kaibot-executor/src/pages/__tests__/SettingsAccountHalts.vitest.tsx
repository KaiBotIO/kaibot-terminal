import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SafetyTab } from '@/pages/Settings';

// Account halts (a daily-loss trip on one exchange+account) show next to the
// global halt, each with its own Re-enable that clears only that account.

type Call = { url: string; method: string; body?: string };

function mockFetch(calls: Call[]) {
  let accountHalts = [{ exchange: 'tradestation', account_id: '21084931', reason: 'daily_loss', tripped_at: Date.UTC(2026, 9, 6, 17, 15) }];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });
    if (url.includes('/api/ops/margin-guards')) {
      return new Response(
        JSON.stringify({
          defaults: {},
          guardrailDefaults: {},
          global: null,
          globalGuardrails: { maxDailyLoss: 0, maxConcurrentPositions: 0, maxTotalNotional: 0 },
          accounts: [],
          halt: { halted: false, reason: null, tripped_at: null },
          accountHalts,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/ops/halt') && method === 'POST') {
      accountHalts = [];
      return new Response(JSON.stringify({ halted: false, reason: null, tripped_at: null, accounts: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('Safety tab account halts', () => {
  it('lists a halted account and re-enables only that account', async () => {
    const calls: Call[] = [];
    mockFetch(calls);
    render(
      <MemoryRouter>
        <SafetyTab />
      </MemoryRouter>,
    );
    expect(await screen.findByText('tradestation 21084931')).toBeTruthy();
    expect(screen.queryByText(/Executor halted/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Re-enable' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/ops/halt') && c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url.endsWith('/api/ops/halt') && c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toMatchObject({ halted: false, exchange: 'tradestation', accountId: '21084931' });
    await waitFor(() => expect(screen.queryByText('tradestation 21084931')).toBeNull());
  });
});
