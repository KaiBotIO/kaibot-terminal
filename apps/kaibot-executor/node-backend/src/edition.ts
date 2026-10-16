// Which KaiBot Terminal this is. `internal` = Kai's own Terminal, shared with
// clients through viewer accounts; `public` = the KaiBotIO mirror build.
// Compiled binaries bake it in through `--define __KAIBOT_EDITION__=...`
// (scripts/build-sidecar.ts does that from KAIBOT_EDITION); an env var on a
// compiled binary is ignored so the edition can't be flipped at runtime.
// Running from source (`bun run src/main.ts`) reads KAIBOT_EDITION instead.
// Anything unset or unknown is `public`.

export type Edition = 'internal' | 'public'

declare const __KAIBOT_EDITION__: string | undefined

export function parseEdition(raw: unknown): Edition {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'internal' ? 'internal' : 'public'
}

export function resolveEdition(opts: { baked: string | undefined; env: string | undefined; compiled: boolean }): Edition {
  if (opts.baked !== undefined) return parseEdition(opts.baked)
  return opts.compiled ? 'public' : parseEdition(opts.env)
}

// Bun mounts a compiled binary's sources under /$bunfs/ (B:/~BUN/ on Windows).
function isCompiledBinary(): boolean {
  const p = import.meta.path
  return p.startsWith('/$bunfs/') || p.includes('~BUN')
}

export const EDITION: Edition = resolveEdition({
  baked: typeof __KAIBOT_EDITION__ === 'string' ? __KAIBOT_EDITION__ : undefined,
  env: process.env.KAIBOT_EDITION,
  compiled: isCompiledBinary(),
})

// Viewer accounts (Settings > Users, account grants) exist only internally.
export function hasViewerAccounts(edition: Edition): boolean {
  return edition === 'internal'
}

export const EDITION_VIEWER_REFUSED_BODY = {
  error: 'Viewer accounts are not available in this edition of KaiBot Terminal.',
  code: 'edition',
} as const

// Login gate: a viewer row in a public DB stays inert.
export function loginRefusal(role: string | undefined, edition: Edition): typeof EDITION_VIEWER_REFUSED_BODY | null {
  return role !== 'admin' && !hasViewerAccounts(edition) ? EDITION_VIEWER_REFUSED_BODY : null
}
