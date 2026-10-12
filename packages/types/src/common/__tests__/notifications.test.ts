import { describe, expect, it } from 'bun:test';
import {
  NOTIFICATION_CATEGORIES,
  PERSONAL_NOTIFICATION_CATEGORIES,
  categoryForSource,
  isPersonalCategory,
  linkForEvent,
  sourcesForCategory,
} from '../notifications';

describe('categoryForSource', () => {
  it('maps known sources to their category', () => {
    expect(categoryForSource('signal')).toBe('signal');
    expect(categoryForSource('position')).toBe('position');
    expect(categoryForSource('bot')).toBe('bot');
    expect(categoryForSource('backtest')).toBe('backtest');
    expect(categoryForSource('scanner')).toBe('sentiment');
  });

  it('falls back to system for unknown sources', () => {
    expect(categoryForSource('whatever')).toBe('system');
    expect(categoryForSource('')).toBe('system');
  });
});

describe('sourcesForCategory', () => {
  it('returns the sources owned by a category', () => {
    expect(sourcesForCategory('sentiment')).toEqual(['scanner']);
    expect(sourcesForCategory('signal')).toEqual(['signal']);
  });

  it('returns nothing for the system catch-all', () => {
    expect(sourcesForCategory('system')).toEqual([]);
  });

  it('every non-system category owns at least one source', () => {
    for (const cat of NOTIFICATION_CATEGORIES) {
      if (cat === 'system') continue;
      expect(sourcesForCategory(cat).length).toBeGreaterThan(0);
    }
  });
});

describe('PERSONAL_NOTIFICATION_CATEGORIES', () => {
  it('excludes the global sentiment context layer', () => {
    expect(PERSONAL_NOTIFICATION_CATEGORIES).not.toContain('sentiment');
  });

  it('keeps every truly-personal category', () => {
    for (const cat of NOTIFICATION_CATEGORIES) {
      if (cat === 'sentiment') continue;
      expect(PERSONAL_NOTIFICATION_CATEGORIES).toContain(cat);
    }
  });

  it('does not map any personal category to the scanner source', () => {
    const personalSources = PERSONAL_NOTIFICATION_CATEGORIES.flatMap(sourcesForCategory);
    expect(personalSources).not.toContain('scanner');
  });
});

describe('isPersonalCategory', () => {
  it('flags sentiment as non-personal and everything else as personal', () => {
    expect(isPersonalCategory('sentiment')).toBe(false);
    expect(isPersonalCategory('signal')).toBe(true);
    expect(isPersonalCategory('position')).toBe(true);
    expect(isPersonalCategory('bot')).toBe(true);
    expect(isPersonalCategory('backtest')).toBe(true);
    expect(isPersonalCategory('system')).toBe(true);
  });
});

describe('linkForEvent', () => {
  it('prefers an explicit metadata.link', () => {
    expect(
      linkForEvent({ source: 'backtest', metadata: { link: '/settings', backtestId: 'bt1' } }),
    ).toBe('/settings');
  });

  it('ignores non-path metadata.link values', () => {
    expect(
      linkForEvent({ source: 'system', metadata: { link: 'https://evil.example' } }),
    ).toBeNull();
  });

  it('resolves known entity ids to their detail pages', () => {
    expect(linkForEvent({ source: 'backtest', metadata: { backtestId: 'bt1' } })).toBe(
      '/backtests/bt1',
    );
    expect(linkForEvent({ source: 'bot', metadata: { botId: 'b1' } })).toBe('/bots/b1');
    expect(linkForEvent({ source: 'system', metadata: { forwardTestId: 'ft1' } })).toBe(
      '/forward-tests/ft1',
    );
  });

  it('maps signalId/positionGroupId to the terminal via assetId', () => {
    expect(
      linkForEvent({ source: 'signal', assetId: 'BTCUSDT', metadata: { signalId: 's1' } }),
    ).toBe('/terminal?symbol=BTCUSDT');
    expect(
      linkForEvent({
        source: 'position',
        assetId: 'ETH/USDT',
        metadata: { positionGroupId: 'pg1' },
      }),
    ).toBe('/terminal?symbol=ETH%2FUSDT');
  });

  it('falls back on source when no ids are present', () => {
    expect(linkForEvent({ source: 'signal', assetId: 'BTCUSDT', metadata: {} })).toBe(
      '/terminal?symbol=BTCUSDT',
    );
    expect(linkForEvent({ source: 'position', assetId: 'SOLUSDT' })).toBe(
      '/terminal?symbol=SOLUSDT',
    );
    expect(linkForEvent({ source: 'scanner' })).toBe('/sentiment');
  });

  it('returns null when nothing resolves', () => {
    expect(linkForEvent({ source: 'signal', metadata: { signalId: 's1' } })).toBeNull();
    expect(linkForEvent({ source: 'system', metadata: {} })).toBeNull();
    expect(linkForEvent({ source: 'bot', metadata: null })).toBeNull();
  });
});
