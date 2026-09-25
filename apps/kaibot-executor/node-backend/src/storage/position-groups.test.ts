import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { KaiBotDatabase } from './database.js'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Migration-030 position_groups + position_group_links: visibility-only group
// identity for live positions (keyed pos:{exchange}:{account}:{symbol}).

let dir: string
let db: KaiBotDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kaibot-pos-groups-'))
  db = new KaiBotDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('position_groups CRUD', () => {
  it('creates, reads, renames and lists groups', () => {
    db.createPositionGroup({ id: 'g1', name: 'BTC Swing', source: 'manual' })
    db.createPositionGroup({ id: 'g2', name: 'ETH Bot', source: 'bot', signalBotId: 'bot-1', botConfigId: 'cfg-1' })

    expect(db.getPositionGroup('g1')?.name).toBe('BTC Swing')
    expect(db.getPositionGroupForBot('bot-1')?.id).toBe('g2')
    expect(db.listPositionGroups()).toHaveLength(2)

    db.renamePositionGroup('g1', 'BTC Macro')
    expect(db.getPositionGroup('g1')?.name).toBe('BTC Macro')
  })

  it('deleting a group nulls its links instead of removing positions', () => {
    db.createPositionGroup({ id: 'g1', name: 'Bot A', source: 'bot', signalBotId: 'bot-a' })
    db.upsertPositionGroupLink({
      positionKey: 'pos:deribit:acc1:BTC-PERPETUAL',
      exchange: 'deribit',
      accountId: 'acc1',
      symbol: 'BTC-PERPETUAL',
      groupId: 'g1',
      assignedBy: 'auto',
    })

    db.deletePositionGroup('g1')
    expect(db.getPositionGroup('g1')).toBeFalsy()
    const link = db.getPositionGroupLink('pos:deribit:acc1:BTC-PERPETUAL')
    expect(link).toBeDefined()
    expect(link?.group_id).toBeNull()
  })
})

describe('position_group_links precedence', () => {
  it('auto never overwrites a user assignment; user always wins', () => {
    db.createPositionGroup({ id: 'g-bot', name: 'Bot', source: 'bot', signalBotId: 'b1' })
    db.createPositionGroup({ id: 'g-user', name: 'Mine', source: 'manual' })
    const key = 'pos:deribit:acc1:ETH-PERPETUAL'
    const base = {
      positionKey: key,
      exchange: 'deribit',
      accountId: 'acc1',
      symbol: 'ETH-PERPETUAL',
    }

    db.upsertPositionGroupLink({ ...base, groupId: 'g-bot', assignedBy: 'auto' })
    expect(db.getPositionGroupLink(key)?.group_id).toBe('g-bot')

    // User re-assigns → pins the link.
    db.upsertPositionGroupLink({ ...base, groupId: 'g-user', assignedBy: 'user' })
    expect(db.getPositionGroupLink(key)?.group_id).toBe('g-user')

    // A later auto write is ignored.
    db.upsertPositionGroupLink({ ...base, groupId: 'g-bot', assignedBy: 'auto' })
    const link = db.getPositionGroupLink(key)
    expect(link?.group_id).toBe('g-user')
    expect(link?.assigned_by).toBe('user')

    // User unassign (NULL) also sticks.
    db.upsertPositionGroupLink({ ...base, groupId: null, assignedBy: 'user' })
    expect(db.getPositionGroupLink(key)?.group_id).toBeNull()
  })

  it('auto refreshes an earlier auto link (new bot claims the reopened key)', () => {
    db.createPositionGroup({ id: 'g-a', name: 'Bot A', source: 'bot', signalBotId: 'a' })
    db.createPositionGroup({ id: 'g-b', name: 'Bot B', source: 'bot', signalBotId: 'b' })
    const base = {
      positionKey: 'pos:bybit:main:SOLUSDT',
      exchange: 'bybit',
      accountId: 'main',
      symbol: 'SOLUSDT',
    }
    db.upsertPositionGroupLink({ ...base, groupId: 'g-a', assignedBy: 'auto' })
    db.upsertPositionGroupLink({ ...base, groupId: 'g-b', assignedBy: 'auto' })
    expect(db.getPositionGroupLink(base.positionKey)?.group_id).toBe('g-b')
  })
})
