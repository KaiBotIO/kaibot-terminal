import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Provider, createStore } from 'jotai';
import { sessionRoleAtom, type SessionRole } from '@/lib/atoms';

// Public edition: no viewer accounts. A stale viewer role never switches the
// UI into view-only mode and Settings has no Users tab.

vi.mock('@/lib/edition', () => ({ EDITION: 'public', HAS_VIEWER_ACCOUNTS: false }));
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
import Settings from '@/pages/Settings';
import { useIsViewer } from '@/hooks/useRole';

function renderAs(role: SessionRole, ui: React.ReactNode) {
  const store = createStore();
  store.set(sessionRoleAtom, role);
  return render(
    <Provider store={store}>
      <MemoryRouter>{ui}</MemoryRouter>
    </Provider>
  );
}

function ViewerProbe() {
  return <div>{useIsViewer() ? 'viewer' : 'admin'}</div>;
}

describe('public edition', () => {
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

  it('useIsViewer is false even with a viewer role', () => {
    renderAs('viewer', <ViewerProbe />);
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('no View only badge', () => {
    renderAs('viewer', <AppTopbar />);
    expect(screen.queryByText('View only')).not.toBeInTheDocument();
  });

  it('admin Settings has no Users tab and never mounts UsersSection', () => {
    renderAs('admin', <Settings />);
    expect(screen.getByRole('tab', { name: 'API Configuration' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Users' })).not.toBeInTheDocument();
    expect(screen.queryByText('users section stub')).not.toBeInTheDocument();
  });
});
