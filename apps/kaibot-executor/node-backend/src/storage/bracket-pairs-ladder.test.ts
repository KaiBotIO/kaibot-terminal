import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase, parseTpOrderIds } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Migration-012 multi-TP ladder on bracket_pairs: a bracket can persist N TP
// order ids (JSON array) while keeping tp_order_id back-compat for old readers.

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-bracket-test-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('bracket_pairs multi-TP ladder', () => {
  it('round-trips a ladder of TP order ids and mirrors the first to tp_order_id', () => {
    db.upsertBracketPair({
      signalId: 'sig-1',
      exchange: 'bybit',
      slOrderId: 'sl-1',
      tpOrderIds: ['tp-1', 'tp-2', 'tp-3'],
    })
    const [row] = db.listBracketPairs()
    expect(row.sl_order_id).toBe('sl-1')
    expect(row.tp_order_id).toBe('tp-1')
    expect(parseTpOrderIds(row.tp_order_ids)).toEqual(['tp-1', 'tp-2', 'tp-3'])
  })

  it('knownOrderIds includes every TP leg id', () => {
    db.upsertBracketPair({
      signalId: 'sig-2',
      exchange: 'bybit',
      slOrderId: 'sl-2',
      tpOrderIds: ['tp-a', 'tp-b'],
    })
    const known = db.listKnownOrderIds('bybit')
    expect(known.has('sl-2')).toBe(true)
    expect(known.has('tp-a')).toBe(true)
    expect(known.has('tp-b')).toBe(true)
  })

  it('shrinking the ladder on a partial fill persists the remaining legs', () => {
    db.upsertBracketPair({ signalId: 'sig-3', exchange: 'bybit', slOrderId: 'sl-3', tpOrderIds: ['tp-x', 'tp-y'] })
    // TP1 filled → keep only TP2.
    db.upsertBracketPair({ signalId: 'sig-3', exchange: 'bybit', slOrderId: 'sl-3', tpOrderIds: ['tp-y'] })
    const [row] = db.listBracketPairs()
    expect(parseTpOrderIds(row.tp_order_ids)).toEqual(['tp-y'])
    expect(row.tp_order_id).toBe('tp-y')
  })

  it('back-compat: single tpOrderId still works', () => {
    db.upsertBracketPair({ signalId: 'sig-4', exchange: 'bybit', slOrderId: 'sl-4', tpOrderId: 'tp-solo' })
    const [row] = db.listBracketPairs()
    expect(row.tp_order_id).toBe('tp-solo')
    expect(parseTpOrderIds(row.tp_order_ids)).toEqual([])
  })
})
