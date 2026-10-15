// Regression: migration 023 (basis_guard) once shipped `ALTER TABLE subscriptions`
// against a table that is actually named `executor_subscriptions`, so a fresh
// KaiBotDatabase threw "no such table: subscriptions" on boot (the catch only
// swallows duplicate-column errors). This guards the boot path + the column.
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { KaiBotDatabase } from './database.js';

const dirs: string[] = [];
function tempDb(): { db: KaiBotDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kaibot-basisguard-'));
  dirs.push(dir);
  const path = join(dir, 'exec.db');
  return { db: new KaiBotDatabase(path), path };
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

describe('migration 023 basis_guard', () => {
  it('a fresh executor DB boots without throwing', () => {
    expect(() => tempDb()).not.toThrow();
  });

  it('adds basis_guard_bps to executor_subscriptions (not to a non-existent `subscriptions`)', () => {
    const { path } = tempDb();
    expect(columns(path, 'executor_subscriptions')).toContain('basis_guard_bps');
  });

  it('the column is usable: a per-subscription override round-trips', () => {
    const { db, path } = tempDb();
    db.upsertSubscription({ id: 'sub-x', signalBotId: 'sb-x', factor: 1, status: 'active' });
    const raw = new Database(path);
    try {
      raw.run('UPDATE executor_subscriptions SET basis_guard_bps = ? WHERE id = ?', [12.5, 'sub-x']);
      const row = raw.query('SELECT basis_guard_bps FROM executor_subscriptions WHERE id = ?').get('sub-x') as any;
      expect(row.basis_guard_bps).toBe(12.5);
    } finally {
      raw.close();
    }
  });

  it('re-opening the same DB file is idempotent (no duplicate-column throw)', () => {
    const { path } = tempDb();
    expect(() => new KaiBotDatabase(path)).not.toThrow();
    expect(columns(path, 'executor_subscriptions').filter((c) => c === 'basis_guard_bps')).toHaveLength(1);
  });
});
