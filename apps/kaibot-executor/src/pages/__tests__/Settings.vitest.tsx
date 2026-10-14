import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Regression test for: /api/ws/connect reads the SAVED backend settings, not
// the settings form. A user who pastes an API key and clicks "Connect"
// without ever hitting the (small, easy to miss) top "Save" button got
// "API configuration incomplete" even though the key is right there on
// screen. Connect (and Test Connection) must save the current form values
// first and only proceed once that save succeeds.

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

type Call = { url: string; method: string };

function mockFetchTracking(calls: Call[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({ url, method });

    if (url.endsWith('/api/user/settings') && method === 'GET') {
      // No key saved yet — matches the reported scenario.
      return new Response(
        JSON.stringify({ settings: { apiConfig: { apiUrl: '', apiKey: '', autoConnect: false } } }),
        { status: 200 }
      );
    }
    if (url.endsWith('/api/user/settings') && method === 'PUT') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (url.endsWith('/api/ws/connect') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, message: 'Connecting to signal service' }), {
        status: 200,
      });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('Settings "Connect" with an unsaved API key', () => {
  beforeEach(() => {
    localStorage.clear();
    refresh.mockClear();
  });

  it('saves the form before calling /api/ws/connect', async () => {
    const calls: Call[] = [];
    mockFetchTracking(calls);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );

    const apiKeyInput = await screen.findByLabelText('API Key');
    // Paste a key into the form WITHOUT clicking the top "Save" button.
    fireEvent.change(apiKeyInput, { target: { value: `kb_${'a'.repeat(64)}` } });

    const connectButton = await screen.findByRole('button', { name: 'Connect' });
    fireEvent.click(connectButton);

    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/api/ws/connect') && c.method === 'POST')).toBe(true)
    );

    const saveIndex = calls.findIndex((c) => c.url.endsWith('/api/user/settings') && c.method === 'PUT');
    const connectIndex = calls.findIndex((c) => c.url.endsWith('/api/ws/connect') && c.method === 'POST');

    // Old behaviour: connect fires straight away with nothing saved yet, so
    // saveIndex stays -1 (or lands after connect) and this fails.
    expect(saveIndex).toBeGreaterThan(-1);
    expect(saveIndex).toBeLessThan(connectIndex);
  });
});
