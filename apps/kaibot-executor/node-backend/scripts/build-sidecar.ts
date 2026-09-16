#!/usr/bin/env bun
// Compile the node-backend into a self-contained binary and name it with the
// Rust host target triple, as Tauri's `externalBin` sidecar resolution expects
// (`binaries/node-backend-<target-triple>[.exe]`).
//
// Usage:
//   bun run scripts/build-sidecar.ts            # host triple (macOS: BOTH darwin
//                                               # arches — the universal bundle
//                                               # needs the two sidecars)
//   bun run scripts/build-sidecar.ts <triple>   # build for an explicit triple
import { spawnSync } from 'bun'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

function hostTargetTriple(): string {
  // `rustc -Vv` prints a line `host: <triple>` — the canonical source of the
  // triple Tauri will look for when bundling for this machine.
  const out = spawnSync(['rustc', '-Vv'], { stdout: 'pipe', stderr: 'pipe' })
  if (out.exitCode === 0) {
    const text = new TextDecoder().decode(out.stdout)
    const match = text.match(/^host:\s*(\S+)/m)
    if (match) return match[1]
  }
  // Fallback for machines without rustc on PATH (e.g. CI building the binary
  // separately): derive from the platform/arch.
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`
  return `${arch}-unknown-linux-gnu`
}

// Bun's cross-compile target for a Rust triple — `--target=bun` would silently
// compile for the host no matter how the output file is named.
function bunTarget(triple: string): string {
  const os = triple.includes('darwin') ? 'darwin' : triple.includes('windows') ? 'windows' : 'linux'
  const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64'
  return `bun-${os}-${arch}`
}

// The macOS bundle is universal (`--target universal-apple-darwin`), and Tauri
// resolves one sidecar per arch — so a default darwin build must produce both.
const triples = process.argv[2]
  ? [process.argv[2]]
  : process.platform === 'darwin'
    ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    : [hostTargetTriple()]

const outDir = join(import.meta.dir, '..', '..', 'src-tauri', 'binaries')
const entry = join(import.meta.dir, '..', 'src', 'main.ts')

// Stamp the release version into the binary so `version`, adoption telemetry
// and the update gate all report the same number. CI sets this from the tag.
const version = process.env.KAIBOT_EXECUTOR_VERSION

for (const triple of triples) {
  const ext = triple.includes('windows') ? '.exe' : ''
  const outFile = join(outDir, `node-backend-${triple}${ext}`)
  console.log(`Compiling node-backend sidecar → binaries/node-backend-${triple}${ext}`)

  const buildArgs = ['bun', 'build', entry, '--compile', `--target=${bunTarget(triple)}`, `--outfile=${outFile}`]
  if (version) {
    buildArgs.push('--define', `process.env.KAIBOT_EXECUTOR_VERSION=${JSON.stringify(version)}`)
  }

  const build = spawnSync(buildArgs, { stdout: 'inherit', stderr: 'inherit', cwd: dirname(entry) })

  if (build.exitCode !== 0) {
    console.error('Sidecar build failed')
    process.exit(build.exitCode ?? 1)
  }

  if (!existsSync(outFile)) {
    console.error(`Expected sidecar at ${outFile} but it was not produced`)
    process.exit(1)
  }

  // AppImage guard: linuxdeploy rewrites rpath with its BUNDLED patchelf, and
  // that rewrite corrupts bun-compiled ELFs (its second pass then dies on
  // `Failed to run ldd`). Pre-setting the exact rpath with the system patchelf
  // makes linuxdeploy's own rewrite an in-place no-op, which is harmless.
  if (triple.includes('linux') && process.platform === 'linux') {
    // Bun's spawnSync throws on a missing executable, so wrap the whole call.
    let exitCode: number | null = null
    try {
      exitCode = spawnSync(['patchelf', '--set-rpath', '$ORIGIN/../lib', outFile],
        { stdout: 'inherit', stderr: 'inherit' }).exitCode
    } catch {
      exitCode = null
    }
    if (exitCode !== 0) {
      // Local dev boxes may lack patchelf; only CI actually bundles AppImages.
      const msg = 'patchelf failed (is patchelf installed?); AppImage bundling would corrupt this sidecar'
      if (process.env.CI) {
        console.error(msg)
        process.exit(exitCode ?? 1)
      }
      console.warn(`warning: ${msg}`)
    }
  }

  console.log(`Sidecar ready: ${outFile}`)
}

// The universal macOS bundle compiles per arch (wants the per-arch sidecars
// above) but bundles ONE fat sidecar named -universal-apple-darwin. Only lipo
// can produce that, so this leg exists only on a darwin host.
if (!process.argv[2] && process.platform === 'darwin') {
  const fat = join(outDir, 'node-backend-universal-apple-darwin')
  const lipo = spawnSync(
    ['lipo', '-create', '-output', fat,
      join(outDir, 'node-backend-aarch64-apple-darwin'),
      join(outDir, 'node-backend-x86_64-apple-darwin')],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (lipo.exitCode !== 0 || !existsSync(fat)) {
    console.error('lipo failed to produce the universal sidecar')
    process.exit(lipo.exitCode ?? 1)
  }
  console.log(`Sidecar ready: ${fat}`)
}
