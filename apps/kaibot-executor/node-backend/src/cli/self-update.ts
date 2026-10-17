import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EXECUTOR_VERSION } from '../version.js'

// Standalone (CLI/Docker) self-update. Pulls the latest GitHub release, finds
// the asset matching this host's target triple, verifies its integrity, then
// replaces the running binary and asks the user to restart. The desktop shell
// uses tauri-plugin-updater (which verifies a minisign signature) instead —
// this path is only for the headless binary.
//
// Integrity model: this app holds exchange API keys and auto-installs as a
// startup service, so an unverified swap is arbitrary-binary RCE as the user.
// We therefore (a) ignore the repo override outside an explicit dev opt-in and
// (b) refuse to swap the binary unless the download matches the SHA-256 the
// release publishes alongside it. There is no "HTTP 200 is enough" path in
// prod — verification failure (including a missing checksum) aborts the update
// with the running binary left untouched.

// The canonical, baked-in update source. Overriding it would let any attacker
// who controls the env (or the override target) serve an arbitrary binary, so
// the override is honored ONLY behind an explicit dev flag.
const CANONICAL_REPO = 'KaiBotIO/kaibot-terminal'

function resolveRepo(): string {
  const override = process.env.KAIBOT_UPDATE_REPO
  if (!override || override === CANONICAL_REPO) return CANONICAL_REPO
  if (process.env.KAIBOT_UPDATE_ALLOW_REPO_OVERRIDE === '1') {
    console.warn(`[update] Using non-canonical update repo (dev override): ${override}`)
    return override
  }
  // Prod / default: refuse the override, fall back to the canonical source.
  console.warn(
    '[update] Ignoring KAIBOT_UPDATE_REPO — the update source is fixed to the canonical repo. ' +
      'Set KAIBOT_UPDATE_ALLOW_REPO_OVERRIDE=1 to override (dev only).',
  )
  return CANONICAL_REPO
}

const REPO = resolveRepo()
const API = `https://api.github.com/repos/${REPO}/releases/latest`

interface GitHubAsset {
  name: string
  browser_download_url: string
}
interface GitHubRelease {
  tag_name: string
  assets: GitHubAsset[]
}

function hostTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
  }
  return 0
}

async function fetchLatest(): Promise<GitHubRelease | null> {
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kaibot-terminal' },
    })
    if (!res.ok) return null
    return (await res.json()) as GitHubRelease
  } catch {
    return null
  }
}

// A `*.sha256` file usually looks like `<hex>  <filename>` (sha256sum format),
// but a bare hex digest is also accepted. Returns the lowercased 64-char hex
// digest, or null if the body doesn't contain a recognizable SHA-256.
function parseSha256(body: string): string | null {
  const match = body.match(/\b[0-9a-fA-F]{64}\b/)
  return match ? match[0].toLowerCase() : null
}

// Fetch the expected SHA-256 for `asset` from its sibling `<name>.sha256`
// release asset. Returns null when no such asset is published (→ fail closed at
// the call site). TODO(B6): wire the release pipeline (.github/workflows/
// executor-release.yml `standalone` job) to publish a `<tarball>.sha256` (and
// ideally a minisign detached signature verified against the desktop updater's
// pubkey) for every standalone tarball, so this stops being the only gate.
async function fetchExpectedSha256(asset: GitHubAsset, release: GitHubRelease): Promise<string | null> {
  const checksumAsset = release.assets.find((a) => a.name === `${asset.name}.sha256`)
  if (!checksumAsset) return null
  try {
    const res = await fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': 'kaibot-terminal' },
    })
    if (!res.ok) return null
    return parseSha256(await res.text())
  } catch {
    return null
  }
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// Best-effort: log on startup when a newer release is out. Never blocks boot.
export async function logUpdateHintOnStart(): Promise<void> {
  if (process.env.KAIBOT_DISABLE_UPDATE_CHECK === '1') return
  const release = await fetchLatest()
  if (!release) return
  if (cmp(EXECUTOR_VERSION, release.tag_name) < 0) {
    console.log(
      `[update] A newer KaiBot Terminal is available: ${release.tag_name} (you have ${EXECUTOR_VERSION}). Run \`kaibot-terminal self-update\`.`,
    )
  }
}

export async function selfUpdate(): Promise<void> {
  console.log(`Current version: ${EXECUTOR_VERSION}`)
  const release = await fetchLatest()
  if (!release) {
    console.error('Could not reach the release feed. Check your network connection.')
    process.exit(1)
  }

  if (cmp(EXECUTOR_VERSION, release.tag_name) >= 0) {
    console.log(`Already up to date (latest is ${release.tag_name}).`)
    return
  }

  if (process.platform === 'win32') {
    console.error('On Windows, update by reinstalling the desktop app (it self-updates) or re-running the installer.')
    process.exit(1)
  }

  const triple = hostTriple()
  // The release ships binary + web UI together as one tarball so the backend
  // and frontend can never drift out of version sync.
  const wantName = `kaibot-terminal-${triple}.tar.gz`
  const asset =
    release.assets.find((a) => a.name === wantName) ||
    release.assets.find((a) => a.name.includes(triple) && a.name.endsWith('.tar.gz'))
  if (!asset) {
    console.error(`No release tarball for ${triple}. Available: ${release.assets.map((a) => a.name).join(', ')}`)
    process.exit(1)
  }

  console.log(`Downloading ${asset.name} (${release.tag_name})…`)
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'kaibot-terminal' } })
  if (!res.ok) {
    console.error(`Download failed: HTTP ${res.status}`)
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  // Integrity gate — fail closed. Verify the download against the SHA-256 the
  // release publishes BEFORE touching the running binary. A missing checksum,
  // an unparseable one, or a mismatch all abort with nothing swapped. (HTTP 200
  // alone is NOT trusted: it can't detect a tampered/MITM'd or repo-substituted
  // payload.)
  const expectedSha = await fetchExpectedSha256(asset, release)
  if (!expectedSha) {
    console.error(
      `Refusing to update: no published checksum (${asset.name}.sha256) for this release, so the ` +
        'download cannot be verified. The binary was left unchanged.',
    )
    process.exit(1)
  }
  const actualSha = sha256Hex(buf)
  if (actualSha !== expectedSha) {
    console.error('Refusing to update: downloaded tarball failed SHA-256 verification.')
    console.error(`  expected ${expectedSha}`)
    console.error(`  actual   ${actualSha}`)
    console.error('The binary was left unchanged.')
    process.exit(1)
  }
  console.log('Checksum verified (SHA-256).')

  // Extract to a temp dir, then atomically swap the binary and the dist/ next to
  // it (resolveStaticDir() looks for dist beside the executable).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaibot-update-'))
  const tarball = path.join(tmpDir, 'release.tar.gz')
  fs.writeFileSync(tarball, buf)
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', tmpDir], { stdio: 'inherit' })
  if (untar.status !== 0) {
    console.error('Failed to extract the update tarball.')
    process.exit(1)
  }

  const newBin = path.join(tmpDir, 'kaibot-terminal')
  const newDist = path.join(tmpDir, 'dist')
  if (!fs.existsSync(newBin)) {
    console.error('Update tarball did not contain the expected binary.')
    process.exit(1)
  }
  fs.chmodSync(newBin, 0o755)

  const target = process.execPath
  const installDir = path.dirname(target)
  const backup = `${target}.bak`
  try {
    // Can't overwrite a running binary in place — move the old one aside.
    try { fs.unlinkSync(backup) } catch {}
    fs.renameSync(target, backup)
    fs.copyFileSync(newBin, target)
    fs.chmodSync(target, 0o755)
    if (fs.existsSync(newDist)) {
      const distTarget = path.join(installDir, 'dist')
      fs.rmSync(distTarget, { recursive: true, force: true })
      fs.cpSync(newDist, distTarget, { recursive: true })
    }
    try { fs.unlinkSync(backup) } catch {}
  } catch (err) {
    console.error('Failed to apply the update:', err instanceof Error ? err.message : err)
    console.error(`The new files are in ${tmpDir} — install them manually.`)
    process.exit(1)
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })

  console.log(`Updated to ${release.tag_name}. Restart the executor to run the new version.`)
}
