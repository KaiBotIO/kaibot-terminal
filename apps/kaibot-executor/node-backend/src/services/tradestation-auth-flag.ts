// TradeStation auth-mode switch (HY4). ONE env var drives backend and frontend:
// TRADESTATION_USE_OAUTH (or its VITE_ alias, so a single exported value covers
// the Vite build too). Default false = CouchDB legacy KaiBotWeb session — the
// active mode until the OAuth app API key is approved. Pure so it's testable.

export function resolveTradestationUseOAuth(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.TRADESTATION_USE_OAUTH ?? env.VITE_TRADESTATION_USE_OAUTH ?? ''
  return raw.trim().toLowerCase() === 'true'
}
