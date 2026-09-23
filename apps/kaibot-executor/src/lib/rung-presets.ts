// Client-side rung-size presets for the manual entry ladder. Plain arithmetic
// only — anything formula-shaped (the recovery calculator) stays server-side.

const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

// Split `total` evenly across `count` rungs. The last rung sweeps the rounding
// remainder so the sizes always sum to exactly `total`.
export function equalSizes(total: number, count: number): number[] {
  if (!(total > 0) || !Number.isInteger(count) || count <= 0) return [];
  const per = round8(total / count);
  const sizes = Array.from({ length: count }, () => per);
  sizes[count - 1] = round8(total - per * (count - 1));
  return sizes;
}

// Linearly ascending split: rung i gets weight i+1, so deeper rungs (later
// rows, further from market) carry more size. Last rung sweeps the remainder.
export function weightedSizes(total: number, count: number): number[] {
  if (!(total > 0) || !Number.isInteger(count) || count <= 0) return [];
  const weightSum = (count * (count + 1)) / 2;
  const sizes: number[] = [];
  let allocated = 0;
  for (let i = 0; i < count - 1; i++) {
    const s = round8((total * (i + 1)) / weightSum);
    sizes.push(s);
    allocated = round8(allocated + s);
  }
  sizes.push(round8(total - allocated));
  return sizes;
}
