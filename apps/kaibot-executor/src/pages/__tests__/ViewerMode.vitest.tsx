import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { sessionRoleAtom, type SessionRole } from '@/lib/atoms';

// View-only accounts: the topbar says so, the chart page (Studio pairing +
// manual trading) is gone, and Settings shrinks to browser preferences.

vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, isDesktop: () => false, openExternalUrl: vi.fn() };
});
vi.mock('@/hooks/useApiConnection', () => ({
  useApiConnection: () => ({ isLoading: false, isConfigured: true, apiUrl: null, error: null, restricted: false, refresh: async () => {} }),
}));
vi.mock('@/lib/ops-api', () => ({
  studioApi: { embedToken: vi.fn(() => Promise.reject(new Error('never called for a viewer'))) },
  opsApi: {},
}));
vi.mock('@/hooks/useTerminalBridge', () => ({ useTerminalBridge: () => ({ iframeRef: { current: null } }) }));
vi.mock('@/components/ManualTradePanel', () => ({ ManualTradePanel: () => <div>manual trade panel stub</div> }));
vi.mock('@/components/UsersSection', () => ({ UsersSection: () => <div>users section stub</div> }));

import AppTopbar from '@/components/AppTopbar';
import Terminal from '@/pages/Terminal';
import Settings from '@/pages/Settings';

function renderAs(role: SessionRole, ui: React.ReactNode) {
  const store = createStore();
  store.set(sessionRoleAtom, role);
  return render(
    <Provider store={store}>
      <MemoryRouter>{ui}</MemoryRouter>
    </Provider>
  );
}

describe('view-only account', () => {
  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/ws/status')) {
        return new Response(JSON.stringify({ connected: false, status: 'disconnected' }), { status: 200 });
      }
      return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => cleanup());

  it('shows the View only badge in the topbar, admin does not', () => {
    renderAs('viewer', <AppTopbar />);
    expect(screen.getByText('View only')).toBeInTheDocument();
    expect(screen.queryByText('My Account & Bots')).not.toBeInTheDocument();
  });

  it('admin topbar has no badge', () => {
    renderAs('admin', <AppTopbar />);
    expect(screen.queryByText('View only')).not.toBeInTheDocument();
  });

  it('replaces the chart page with a notice: no Studio frame, no manual trade panel', async () => {
    renderAs('viewer', <Terminal />);
    expect(await screen.findByText(/not part of a view-only account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Studio' })).not.toBeInTheDocument();
    expect(screen.queryByText('manual trade panel stub')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('admin still gets the chart workspace', () => {
    renderAs('admin', <Terminal />);
    expect(screen.getAllByRole('button', { name: 'Open in Studio' }).length).toBeGreaterThan(0);
    expect(screen.getByText('manual trade panel stub')).toBeInTheDocument();
  });

  it('shrinks Settings to display preferences: no pairing, sizing, safety or users tabs', () => {
    renderAs('viewer', <Settings />);
    expect(screen.getByText('Display preferences for this browser.')).toBeInTheDocument();
    expect(screen.getByLabelText('Timestamps')).toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    for (const tab of ['API Configuration', 'Account Sizing', 'Safety', 'Alerting', 'Users']) {
      expect(screen.queryByText(tab)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('admin Settings carries the Users tab on the web build', () => {
    renderAs('admin', <Settings />);
    expect(screen.getByRole('tab', { name: 'Users' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'API Configuration' })).toBeInTheDocument();
  });
});
