import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Regression test for: "Open in Studio" used window.open(), which is a no-op
// in the Tauri desktop webview. Terminal.tsx must go through openExternalUrl
// (system browser on desktop, new tab on web) instead.

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/utils', () => ({ openExternalUrl, isDesktop: () => false }));

vi.mock('@/lib/ops-api', () => ({
  studioApi: { embedToken: () => Promise.reject(new Error('no embed token in test')) },
}));

vi.mock('@/hooks/useTerminalBridge', () => ({
  useTerminalBridge: () => ({ iframeRef: { current: null } }),
}));

vi.mock('@/components/ManualTradePanel', () => ({
  ManualTradePanel: () => <div>manual trade panel stub</div>,
}));

import Terminal from '@/pages/Terminal';

describe('Terminal "Open in Studio"', () => {
  beforeEach(() => {
    openExternalUrl.mockClear();
    (window as any).open = vi.fn();
  });

  it('opens the online terminal via openExternalUrl, not window.open', () => {
    render(
      <MemoryRouter>
        <Terminal />
      </MemoryRouter>
    );

    // Only the header button exists at this point; a second "Open in Studio"
    // button may appear later in the fallback banner once the (mocked,
    // rejecting) embed-token lookup resolves — grab the first regardless.
    const [button] = screen.getAllByRole('button', { name: 'Open in Studio' });
    fireEvent.click(button);

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(expect.stringContaining('http'));
    expect(window.open).not.toHaveBeenCalled();
  });

  // A tab opened from here is the FULL app, so it must not carry the
  // chromeless embed flag the iframe uses.
  it('opens Studio without the embed flag', () => {
    render(
      <MemoryRouter>
        <Terminal />
      </MemoryRouter>
    );

    const [button] = screen.getAllByRole('button', { name: 'Open in Studio' });
    fireEvent.click(button);

    expect(openExternalUrl).toHaveBeenCalledWith(expect.not.stringContaining('embed=1'));
  });
});

describe('Terminal embed frame', () => {
  it('loads Studio chromeless (?embed=1) so the chart is not wrapped in a second app shell', async () => {
    render(
      <MemoryRouter>
        <Terminal />
      </MemoryRouter>
    );

    // The mocked embed-token lookup rejects, so the frame falls back to the
    // plain Studio URL — which still has to carry the embed flag.
    // findAll: earlier renders in this file stay in the document (no auto-cleanup).
    const frames = await screen.findAllByTitle('KaiBot Studio chart');
    expect(frames[frames.length - 1].getAttribute('src')).toContain('embed=1');
  });
});
