// Migration 038 (stop_floor): server_exit_state gains manual_stop,
// trailing_lock and engine_stop; existing rows get engine_stop backfilled from
// current_stop so the favourable-only check keeps its reference.
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { KaiBotDatabase } from './database.js'

const dirs: string[] = []
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kaibot-stop-floor-mig-'))
  dirs.push(dir)
  return join(dir, 'exec.db')
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function columns(path: string): string[] {
  const raw = new Database(path, { readonly: true })
  try {
    return (raw.query('PRAGMA table_info(server_exit_state)').all() as Array<{ name: string }>).map((c) => c.name)
  } finally {
    raw.close()
  }
}

describe('migration 038 stop_floor', () => {
  it('adds the floor columns to server_exit_state', () => {
    const path = tempPath()
    new KaiBotDatabase(path).close()
    const cols = columns(path)
    expect(cols).toContain('manual_stop')
    expect(cols).toContain('trailing_lock')
    expect(cols).toContain('engine_stop')
  })

  it('backfills engine_stop from current_stop on rows that predate the migration', () => {
    const path = tempPath()
    let db = new KaiBotDatabase(path)
    db.upsertServerExitState({
      positionId: 'pos-1', entrySignalId: 'entry-1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', currentStop: 55000, slOrderId: 'sl-0',
    })
    db.close()
    // Roll the DB back to the pre-038 state of that row.
    const raw = new Database(path)
    raw.run('UPDATE server_exit_state SET engine_stop = NULL')
    raw.run("DELETE FROM migrations WHERE name = 'stop_floor'")
    raw.close()

    db = new KaiBotDatabase(path)
    const row = db.getServerExitState('pos-1')!
    expect(row.engine_stop).toBe(55000)
    expect(row.manual_stop).toBeNull()
    expect(row.trailing_lock).toBe(0)
    db.close()
  })

  it('re-opening the same file is idempotent', () => {
    const path = tempPath()
    new KaiBotDatabase(path).close()
    expect(() => new KaiBotDatabase(path).close()).not.toThrow()
    expect(columns(path).filter((c) => c === 'manual_stop')).toHaveLength(1)
  })

  it('the floor round-trips and a fresh upsert never clears it', () => {
    const path = tempPath()
    const db = new KaiBotDatabase(path)
    db.upsertServerExitState({
      positionId: 'pos-1', entrySignalId: 'entry-1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', currentStop: 55000, slOrderId: 'sl-0',
    })
    db.updateServerExitStopFloor('pos-1', { manualStop: 58000, trailingLock: true })
    db.upsertServerExitState({
      positionId: 'pos-1', entrySignalId: 'entry-1', exchange: 'deribit', symbol: 'BTC-PERPETUAL',
      direction: 'long', currentStop: 56000, slOrderId: 'sl-1',
    })
    const row = db.getServerExitState('pos-1')!
    expect(row.manual_stop).toBe(58000)
    expect(row.trailing_lock).toBe(1)
    expect(row.engine_stop).toBe(56000)
    db.close()
  })
})
