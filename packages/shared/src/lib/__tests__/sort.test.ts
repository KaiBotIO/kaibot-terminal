import { describe, expect, it } from 'bun:test';
import { compareVals, sortRows } from '../sort';

describe('compareVals', () => {
  it('compares numbers numerically', () => {
    expect(compareVals(2, 10)).toBeLessThan(0);
    expect(compareVals(10, 2)).toBeGreaterThan(0);
    expect(compareVals(3, 3)).toBe(0);
  });

  it('compares strings by locale', () => {
    expect(compareVals('alpha', 'beta')).toBeLessThan(0);
    expect(compareVals('beta', 'alpha')).toBeGreaterThan(0);
  });

  it('sorts null/undefined/NaN after real values', () => {
    expect(compareVals(null, 1)).toBeGreaterThan(0);
    expect(compareVals(1, undefined)).toBeLessThan(0);
    expect(compareVals(NaN, 'x')).toBeGreaterThan(0);
    expect(compareVals(null, undefined)).toBe(0);
  });
});

describe('sortRows', () => {
  const rows = [
    { id: 'a', v: 3 as number | null },
    { id: 'b', v: null },
    { id: 'c', v: 1 },
    { id: 'd', v: 2 },
  ];

  it('sorts ascending with nulls last', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id)).toEqual([
      'c',
      'd',
      'a',
      'b',
    ]);
  });

  it('sorts descending with nulls still last', () => {
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id)).toEqual([
      'a',
      'd',
      'c',
      'b',
    ]);
  });

  it('does not mutate the input', () => {
    const before = rows.map((r) => r.id);
    sortRows(rows, (r) => r.v, 'asc');
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});
