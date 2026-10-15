import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { exchangeSessionsAtom, type ExchangeSession } from '@/lib/atoms';
import type { OrderPrefill } from '@/lib/order-prefill';

vi.mock('@/hooks/useBrokerData', () => ({
  useBrokerData: () => ({ refresh: vi.fn(), isStale: false, lastUpdated: null }),
}));
vi.mock('@/hooks/usePolledResource', () => ({
  usePolledResource: () => ({ data: undefined, refresh: vi.fn() }),
}));
// Deribit wallets per settle currency, namespaced on a labeled connection.
const accountsFor = (url: string) => {
  if (!url.includes('/accounts/deribit')) return [];
  const ns = url.includes('account=acct1') ? 'acct1/' : '';
  return [{ accountId: `${ns}btc` }, { accountId: `${ns}eth` }];
};
vi.mock('@/lib/api', () => ({
  apiFetch: (url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(accountsFor(url)) }),
}));

import { ManualTradePanel } from '@/components/ManualTradePanel';

const sessions: ExchangeSession[] = [
  { exchangeName: 'tradestation', label: 'default', accountKey: null, status: 'connected' },
  { exchangeName: 'deribit', label: 'acct1', accountKey: 'acct1', status: 'connected' },
  { exchangeName: 'deribit', label: 'default', accountKey: null, status: 'connected' },
  { exchangeName: 'bybit', label: 'default', accountKey: null, status: 'connected' },
];

function renderPanel(prefill: OrderPrefill | null, initialSessions: ExchangeSession[] = sessions) {
  const store = createStore();
  store.set(exchangeSessionsAtom, initialSessions);
  const view = render(
    <Provider store={store}>
      <ManualTradePanel prefill={prefill} />
    </Provider>,
  );
  const rerender = (next: OrderPrefill | null) =>
    view.rerender(
      <Provider store={store}>
        <ManualTradePanel prefill={next} />
      </Provider>,
    );
  return { rerender, store };
}

// The fields have no <label for>; each sits in a block under its caption.
const field = <T extends Element>(caption: string, tag: string) =>
  screen.getByText(caption, { selector: 'span' }).parentElement!.querySelector(tag) as unknown as T;
const exchangeSelect = () => field<HTMLSelectElement>('Exchange', 'select');
const symbolInput = () => field<HTMLInputElement>('Symbol', 'input');
const sizeInput = () => field<HTMLInputElement>('Size', 'input');
const stopInput = () => field<HTMLInputElement>('Stop loss', 'input');
const accountSelect = () => field<HTMLSelectElement>('Account', 'select');

afterEach(cleanup);

describe('ManualTradePanel prefill', () => {
  it('keeps its own default without a prefill', async () => {
    renderPanel(null);
    await waitFor(() => expect(exchangeSelect().value).toBe('tradestation'));
    expect(symbolInput().value).toBe('MNQ');
  });

  it('takes the chart pair: venue connection plus symbol', async () => {
    renderPanel({ exchange: 'bybit', symbol: 'DYDXUSDT' });
    await waitFor(() => expect(exchangeSelect().value).toBe('bybit'));
    expect(symbolInput().value).toBe('DYDXUSDT');
  });

  it('picks the default connection on a multi-account venue', async () => {
    renderPanel({ exchange: 'deribit', symbol: 'ETH-PERPETUAL' });
    await waitFor(() => expect(exchangeSelect().value).toBe('deribit'));
    expect(symbolInput().value).toBe('ETH-PERPETUAL');
  });

  it('lets the user override it and only re-applies on a new pair', async () => {
    const { rerender } = renderPanel({ exchange: 'bybit', symbol: 'DYDXUSDT' });
    await waitFor(() => expect(symbolInput().value).toBe('DYDXUSDT'));

    fireEvent.change(exchangeSelect(), { target: { value: 'tradestation' } });
    fireEvent.change(symbolInput(), { target: { value: 'MGC' } });
    // Same pair again (the chart re-announcing it): no fight.
    rerender({ exchange: 'bybit', symbol: 'DYDXUSDT' });
    await waitFor(() => expect(exchangeSelect().value).toBe('tradestation'));
    expect(symbolInput().value).toBe('MGC');

    // User picks another pair in the chart: the panel follows.
    rerender({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' });
    await waitFor(() => expect(exchangeSelect().value).toBe('deribit'));
    expect(symbolInput().value).toBe('BTC-PERPETUAL');
  });

  it('ignores a pair on a venue without a connection', async () => {
    renderPanel({ exchange: 'binance', symbol: 'SOLUSDT' });
    await waitFor(() => expect(exchangeSelect().value).toBe('tradestation'));
    expect(symbolInput().value).toBe('MNQ');
  });

  it('does not switch under typed order values; the chip switches and clears them', async () => {
    const { rerender } = renderPanel({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' });
    await waitFor(() => expect(symbolInput().value).toBe('BTC-PERPETUAL'));
    expect(screen.getByText('Following chart: DERIBIT:BTC-PERPETUAL')).toBeTruthy();

    fireEvent.change(sizeInput(), { target: { value: '1000' } });
    fireEvent.change(stopInput(), { target: { value: '60000' } });
    rerender({ exchange: 'tradestation', symbol: 'MNQ' });

    const chip = await screen.findByRole('button', { name: 'Chart: TRADESTATION:MNQ · use' });
    expect(exchangeSelect().value).toBe('deribit');
    expect(symbolInput().value).toBe('BTC-PERPETUAL');
    expect(sizeInput().value).toBe('1000');
    expect(stopInput().value).toBe('60000');

    fireEvent.click(chip);
    await waitFor(() => expect(exchangeSelect().value).toBe('tradestation'));
    expect(symbolInput().value).toBe('MNQ');
    expect(sizeInput().value).toBe('');
    expect(stopInput().value).toBe('');
    expect(screen.queryByRole('button', { name: /^Chart:/ })).toBeNull();
  });

  it('keeps a labeled connection when the chart moves within its venue', async () => {
    const { rerender } = renderPanel({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' });
    await waitFor(() => expect(exchangeSelect().value).toBe('deribit'));
    fireEvent.change(exchangeSelect(), { target: { value: 'deribit:acct1' } });
    await waitFor(() => expect(accountSelect().value).toBe('acct1/btc'));
    rerender({ exchange: 'deribit', symbol: 'ETH-PERPETUAL' });
    await waitFor(() => expect(symbolInput().value).toBe('ETH-PERPETUAL'));
    expect(exchangeSelect().value).toBe('deribit:acct1');
    await waitFor(() => expect(accountSelect().value).toBe('acct1/eth'));
  });

  it('derives the Deribit wallet from a typed symbol too', async () => {
    renderPanel({ exchange: 'deribit', symbol: 'BTC-PERPETUAL' });
    await waitFor(() => expect(accountSelect().value).toBe('btc'));
    fireEvent.change(symbolInput(), { target: { value: 'ETH-PERPETUAL' } });
    await waitFor(() => expect(accountSelect().value).toBe('eth'));
  });

  it('retires a pending chip when a newer pair cannot be traded', async () => {
    const { rerender } = renderPanel({ exchange: 'bybit', symbol: 'DYDXUSDT' });
    await waitFor(() => expect(symbolInput().value).toBe('DYDXUSDT'));
    fireEvent.change(sizeInput(), { target: { value: '50' } });
    rerender({ exchange: 'tradestation', symbol: 'MNQ' });
    await screen.findByRole('button', { name: 'Chart: TRADESTATION:MNQ · use' });

    rerender({ exchange: 'index', symbol: 'BTC' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Chart:/ })).toBeNull());
    expect(exchangeSelect().value).toBe('bybit');
    expect(sizeInput().value).toBe('50');
  });

  it('keeps the URL pair until its venue connects', async () => {
    const { store } = renderPanel({ exchange: 'bybit', symbol: 'DYDXUSDT' }, sessions.filter((s) => s.exchangeName !== 'bybit'));
    await waitFor(() => expect(exchangeSelect().value).toBe('tradestation'));
    act(() => store.set(exchangeSessionsAtom, sessions));
    await waitFor(() => expect(exchangeSelect().value).toBe('bybit'));
    expect(symbolInput().value).toBe('DYDXUSDT');
  });
});
