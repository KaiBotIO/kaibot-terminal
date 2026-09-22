import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthCheck } from '@/components/AuthCheck';
import Setup from '@/pages/Setup';

// Regression test for: on desktop, completing first-run setup called
// navigate('/') while AuthCheck still held its stale 'setup' status from the
// initial mount-only check, so AuthCheck bounced straight back to /setup
// until the app was fully restarted. Setup now calls refreshAuthStatus()
// (exposed by AuthCheck) before navigating, so the status is current by the
// time the route change is evaluated.

function mockDesktopFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    // No admin account yet -> AuthCheck's initial check resolves to 'setup'.
    if (url.endsWith('/api/auth/me') && method === 'GET') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    // Account creation succeeds and returns a session token.
    if (url.endsWith('/api/auth/setup') && method === 'POST') {
      return new Response(JSON.stringify({ success: true, token: 'test-token' }), { status: 200 });
    }
    // Best-effort legal-acceptance write.
    if (url.endsWith('/api/user/settings') && method === 'PUT') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    // Token validation on refresh -> now authenticated.
    if (url.endsWith('/api/user/settings') && method === 'GET') {
      return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    }

    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  }) as unknown as typeof fetch;
}

describe('Setup on desktop', () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).__TAURI__ = {};
    mockDesktopFetch();
  });

  it('lands on the main app right after account creation, without a restart', async () => {
    render(
      <MemoryRouter initialEntries={['/setup']}>
        <AuthCheck>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/" element={<div>MAIN APP CONTENT</div>} />
          </Routes>
        </AuthCheck>
      </MemoryRouter>
    );

    // Initial auth check resolves and renders the create-account form.
    await screen.findByLabelText('Username');

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('checkbox'));

    const form = document.getElementById('setup-password-form') as HTMLFormElement;
    fireEvent.submit(form);

    // Old behaviour: AuthCheck's stale 'setup' status bounces this back to
    // /setup, so this text never appears and the assertion below times out.
    await waitFor(() => expect(screen.getByText('MAIN APP CONTENT')).toBeInTheDocument());
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
  });
});
