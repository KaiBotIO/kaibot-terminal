import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChartLink } from '@/components/ChartLink';

afterEach(cleanup);

describe('ChartLink', () => {
  it('renders the icon as a labelled link to the chart route', () => {
    render(
      <MemoryRouter>
        <ChartLink to="/terminal?symbol=MGC&exchange=tradestation" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Open chart' });
    expect(link.getAttribute('href')).toBe('/terminal?symbol=MGC&exchange=tradestation');
  });

  it('makes the symbol itself the link', () => {
    render(
      <MemoryRouter>
        <ChartLink to="/terminal?symbol=BTC-PERPETUAL&exchange=deribit">BTC-PERPETUAL</ChartLink>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'BTC-PERPETUAL' })).toBeTruthy();
  });

  it('does not trigger the surrounding row click or Enter handler', () => {
    const onRowClick = vi.fn();
    const onRowKey = vi.fn();
    render(
      <MemoryRouter>
        <div role="button" tabIndex={0} onClick={onRowClick} onKeyDown={onRowKey}>
          <ChartLink to="/terminal?symbol=BTCUSDT&exchange=bybit" />
        </div>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Open chart' });
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(onRowClick).not.toHaveBeenCalled();
    expect(onRowKey).not.toHaveBeenCalled();
  });
});
