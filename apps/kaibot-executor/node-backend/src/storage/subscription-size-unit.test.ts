// Migration 025 (subscription_size_unit): adds size_unit to executor_subscriptions
// so a bot can size in USD. Guards the column + the upsert round-trip.
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { KaiBotDatabase } from './database.js';

const dirs: string[] = [];
function tempDb(): { db: KaiBotDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kaibot-sizeunit-'));
  dirs.push(dir);
  return { db: new KaiBotDatabase(join(dir, 'exec.db')), path: join(dir, 'exec.db') };
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function columns(path: string, table: string): string[] {
  const raw = new Database(path, { readonly: true });
  try {
    return (raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    raw.close();
  }
}

describe('migration 025 subscription size_unit', () => {
  it('adds size_unit to executor_subscriptions', () => {
    const { path } = tempDb();
    expect(columns(path, 'executor_subscriptions')).toContain('size_unit');
  });

  it("round-trips 'usd' through upsertSubscription", () => {
    const { db } = tempDb();
    db.upsertSubscription({ id: 's1', signalBotId: 'b1', factor: 2, status: 'active', sizeUnit: 'usd' });
    const row = db.getSubscriptionForBot('b1') as { size_unit?: string; factor?: number } | undefined;
    expect(row?.size_unit).toBe('usd');
    expect(Number(row?.factor)).toBe(2);
  });

  it('defaults to null (native) when unset', () => {
    const { db } = tempDb();
    db.upsertSubscription({ id: 's2', signalBotId: 'b2', factor: 1, status: 'active' });
    const row = db.getSubscriptionForBot('b2') as { size_unit?: string | null } | undefined;
    expect(row?.size_unit ?? null).toBeNull();
  });
});
