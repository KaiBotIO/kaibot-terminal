// Regression: the 0.1.0 release shipped a daemon whose first boot crashed on a
// user machine — schema.sql was loaded with readFileSync(__dirname), which in a
// compiled binary resolves to the BUILD machine's path. All .sql assets must be
// embedded (sql-assets.ts) and every file on disk must be present there, so a
// newly added migration can't silently miss the binary again.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { sqlAsset, sqlAssetNames } from './sql-assets'

const storageDir = import.meta.dir

describe('sql-assets embedding', () => {
  test('every .sql file on disk is embedded with identical content', () => {
    const onDisk = [
      'schema.sql',
      ...readdirSync(join(storageDir, 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => `migrations/${f}`),
    ]
    for (const rel of onDisk) {
      expect(sqlAssetNames).toContain(rel)
      expect(sqlAsset(rel)).toBe(readFileSync(join(storageDir, rel), 'utf-8'))
    }
  })

  test('every sqlAsset() reference in database.ts resolves', () => {
    const src = readFileSync(join(storageDir, 'database.ts'), 'utf-8')
    const refs = [...src.matchAll(/sqlAsset\('([^']+)'\)/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(0)
    for (const rel of refs) {
      expect(() => sqlAsset(rel)).not.toThrow()
      expect(sqlAsset(rel).length).toBeGreaterThan(0)
    }
  })

  test('unknown asset throws instead of returning undefined', () => {
    expect(() => sqlAsset('migrations/999_nope.sql')).toThrow(/not embedded/)
  })
})
