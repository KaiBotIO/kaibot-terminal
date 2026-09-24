import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Regression: saving the Studio API key left every pairing surface on its old
// state. Connect only became usable after navigating away from Settings and
// back (a remount re-read /api/user/settings). The save now publishes the new
// pairing state to the shared store and pairs the signal service itself.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/hooks/usePolledResource', () => ({
  usePolledResource: () => ({
    data: { connected: false, status: 'disconnected' },
    error: null,
    isStale: false,
    lastUpdated: null,
    isLoading: false,
    refresh,
  }),
}));

import Settings from '@/pages/Settings';
import { useApiConnection } from '@/hooks/useApiConnection';
import { getApiConnectionSnapshot, resetApiConnectionStore } from '@/lib/api-connection-store';

const KEY = `kb_${'a'.repeat(32)}`;

type Call = { url: string; method: string; body?: string };

function mockFetch(calls: Call[], storedKey = '', obfuscate = false) {
  let saved = storedKey;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body as string | undefined });

    if (url.endsWith('/api/user/settings') && method === 'GET') {
      return new Response(
        JSON.stringify({
          settings: {
            apiConfig: { apiUrl: '', apiKey: saved, autoConnect: false },
            general: { obfuscateSensitiveData: obfuscate },
          },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/api/user/settings') && method === 'PUT') {
      saved = JSON.parse(init?.body as string).settings.apiConfig.apiKey;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.endsWith('/api/ws/connect') && method === 'POST') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

// Stands in for the topbar / dashboard / subscription wizard: a surface that
// reads the pairing state and is NOT remounted when Settings saves.
function PairingProbe() {
  const { isConfigured } = useApiConnection(0);
  return <div data-testid="probe">{isConfigured ? 'paired' : 'unpaired'}</div>;
}

describe('Saving the Studio API key', () => {
  beforeEach(() => {
    localStorage.clear();
    refresh.mockClear();
    resetApiConnectionStore();
  });

  it('leaves Connect usable and pairs without a remount', async () => {
    const calls: Call[] = [];
    mockFetch(calls);

    render(
      <MemoryRouter>
        <PairingProbe />
        <Settings />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('unpaired'));

    fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: KEY } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    // The never-remounted surface flips over to paired.
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('paired'));
    expect(getApiConnectionSnapshot().isConfigured).toBe(true);

    // Saving a fresh key pairs the signal service on its own.
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/ws/connect') && c.method === 'POST')).toBe(true),
    );

    // And Connect is right there, enabled, for a retry.
    const connect = screen.getByRole('button', { name: 'Connect' });
    expect(connect).not.toBeDisabled();
  });

  it('does not re-pair when an unrelated setting is saved', async () => {
    const calls: Call[] = [];
    mockFetch(calls, KEY);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    await waitFor(() => expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe(KEY));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/user/settings') && c.method === 'PUT')).toBe(true),
    );
    expect(calls.some((c) => c.url.endsWith('/api/ws/connect'))).toBe(false);
  });

  it('keeps the key field usable while sensitive data is obfuscated', async () => {
    const calls: Call[] = [];
    mockFetch(calls, KEY, true);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    const field = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    await waitFor(() => expect(field.value).not.toBe(KEY));

    // Old behaviour: obfuscation DISABLED the field, so the key could never be
    // entered or replaced without turning obfuscation off first.
    expect(field.disabled).toBe(false);

    fireEvent.focus(field);
    await waitFor(() => expect(field.value).toBe(KEY));
    fireEvent.change(field, { target: { value: `${KEY}x` } });
    expect(field.value).toBe(`${KEY}x`);
  });
});
