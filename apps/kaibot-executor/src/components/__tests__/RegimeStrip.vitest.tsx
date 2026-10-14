import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(() => Promise.reject(new Error('not fetched in these tests'))) }));

import { RegimeBadge, RegimeStrip } from '@/components/RegimeStrip';

const st = (label: 'not_bull' | 'early_bull' | 'late_bull' | 'unknown', since: string, phaseSince = since) => ({
  label, since, phaseSince, weekClosed: '2026-10-05', close: 1, sma40: 1, sma40_4ago: 1,
});

afterEach(cleanup);
// Dates in the current year drop the year; pin it.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('RegimeBadge', () => {
  const lateMnq = { market: 'MNQ' as const, label: 'late_bull' as const, since: '2026-04-06', phaseSince: '2026-04-13', weekClosed: '2026-10-05', multiplier: 1.5 };

  it('label + since, and the effective multiplier when factors are set', () => {
    render(<RegimeBadge regime={lateMnq} factors={{ lateBull: 1.5 }} />);
    expect(screen.getByText('late bull since 13/04 (bull since 06/04)')).toBeTruthy();
    expect(screen.getByTestId('regime-multiplier').textContent).toBe('x1,5 late bull');
  });

  it('no multiplier chip without factors', () => {
    render(<RegimeBadge regime={lateMnq} factors={null} />);
    expect(screen.getByText('late bull since 13/04 (bull since 06/04)')).toBeTruthy();
    expect(screen.queryByTestId('regime-multiplier')).toBeNull();
  });

  it('nothing for a sub outside every regime group', () => {
    const { container } = render(<RegimeBadge regime={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('RegimeStrip', () => {
  it('one compact line per group', () => {
    render(
      <RegimeStrip
        markets={{ MNQ: st('late_bull', '2026-04-06', '2026-04-13'), MGC: st('not_bull', '2026-08-24'), BTC: st('not_bull', '2025-11-10'), ALTS: st('not_bull', '2025-11-10') }}
      />,
    );
    expect(screen.getByTestId('regime-strip').textContent).toBe(
      'RegimeMNQ late bull since 13/04 (bull since 06/04)MGC not bull since 24/08BTC not bull since 10/11/2025',
    );
  });

  it('renders nothing before the first answer', () => {
    const { container } = render(<RegimeStrip markets={null} />);
    expect(container.textContent).toBe('');
  });
});
