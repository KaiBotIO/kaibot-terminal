import fs from 'node:fs'

// The executor's reported version. Stamped at compile time via Bun's --define
// (`process.env.KAIBOT_EXECUTOR_VERSION`); falls back to the source default in
// dev. Keep this default in sync with apps/kaibot-executor/package.json.
// 0.2.0 = composite-capable (venue resolver + canonical symbol mapping +
// basis guard). 0.3.0 = dynamic symbols (payload venueSymbols map + USDC-perp
// support). The server gates composite/dynamic signal delivery on these.
export const EXECUTOR_VERSION = process.env.KAIBOT_EXECUTOR_VERSION ?? '0.3.0'

export type BuildType = 'tauri' | 'cli' | 'docker'

// How this engine was packaged. Each installer sets KAIBOT_BUILD_TYPE; we infer
// when it's absent (Tauri exports TAURI=1, Docker mounts /.dockerenv).
export function getBuildType(): BuildType {
  const explicit = process.env.KAIBOT_BUILD_TYPE
  if (explicit === 'tauri' || explicit === 'cli' || explicit === 'docker') return explicit
  if (process.env.TAURI === '1') return 'tauri'
  try {
    if (fs.existsSync('/.dockerenv')) return 'docker'
  } catch {
    /* not on a filesystem where this matters */
  }
  return 'cli'
}

export const EXECUTOR_PLATFORM = `${process.platform}-${process.arch}`
