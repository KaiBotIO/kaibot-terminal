#!/usr/bin/env bun
/**
 * Isolated executor instance for e2e pairing tests.
 *
 * Spins up a fresh backend + web UI against a throwaway data dir, so the
 * setup -> login -> pair -> connect flow can be exercised end to end WITHOUT
 * touching the real local instance (Kai's admin credential, exchange keys and
 * DB under node-backend/data/ stay untouched — this never writes there).
 *
 * Usage:
 *   bun test-instance.mjs                 # fresh temp dir, auto-cleaned on exit
 *   bun test-instance.mjs --keep          # keep the data dir after exit
 *   bun test-instance.mjs --data-dir <p>  # use/reuse an explicit dir (implies --keep)
 *
 * Env overrides:
 *   TEST_BACKEND_PORT   backend listen port (default 8190)
 *   TEST_WEB_PORT       vite web port       (default 1490)
 *   KAIBOT_API_URL      signal service URL the executor pairs against
 *
 * Open http://<host>:<TEST_WEB_PORT> — first load shows the setup screen
 * because the temp dir has no admin user yet.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const getArg = (n) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined
}
const keep = args.includes('--keep') || Boolean(getArg('data-dir'))

const backendPort = process.env.TEST_BACKEND_PORT || '8190'
const webPort = process.env.TEST_WEB_PORT || '1490'

const explicitDir = getArg('data-dir')
const dataDir = explicitDir
  ? resolve(explicitDir)
  : mkdtempSync(join(tmpdir(), 'kaibot-exec-test-'))
if (explicitDir && !existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })

console.log('── isolated executor test instance ──')
console.log(`  data dir : ${dataDir}${keep ? ' (kept)' : ' (temp, auto-cleaned)'}`)
console.log(`  backend  : http://localhost:${backendPort}`)
console.log(`  web UI   : http://localhost:${webPort}`)
console.log(`  pairs to : ${process.env.KAIBOT_API_URL || '(set KAIBOT_API_URL)'}`)
console.log('  → open the web UI; first load = setup screen (fresh, no admin)')
console.log('─────────────────────────────────────')

// Backend: KAIBOT_DATA_DIR isolates DB + crypto salt/secret into the temp dir.
const backend = spawn('bun', ['run', 'dev'], {
  cwd: 'node-backend',
  env: { ...process.env, PORT: backendPort, KAIBOT_DATA_DIR: dataDir },
  stdio: 'inherit',
})

// Web: vite proxies /api + /ws to EXECUTOR_BACKEND_PORT (vite.config.ts).
const frontend = spawn('bun', ['vite', '--port', webPort], {
  env: { ...process.env, EXECUTOR_BACKEND_PORT: backendPort, VITE_PORT: webPort },
  stdio: 'inherit',
})

let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  backend.kill()
  frontend.kill()
  if (!keep) {
    try {
      rmSync(dataDir, { recursive: true, force: true })
      console.log(`\nremoved temp data dir ${dataDir}`)
    } catch {
      /* best-effort */
    }
  } else {
    console.log(`\nkept data dir ${dataDir}`)
  }
}

process.on('SIGINT', () => { cleanup(); process.exit() })
process.on('SIGTERM', () => { cleanup(); process.exit() })
backend.on('exit', (code) => { console.log(`backend exited (${code})`); cleanup(); process.exit(code ?? 0) })
frontend.on('exit', (code) => { console.log(`frontend exited (${code})`); cleanup(); process.exit(code ?? 0) })
