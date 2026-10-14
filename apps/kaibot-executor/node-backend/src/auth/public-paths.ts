// Routes needed before/around login. Nothing here may name a user: the web
// build is LAN-bound, so an anonymous caller must not learn the admin username.
export const PUBLIC_API_PATHS: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/setup-status',
  '/api/auth/logout',
  // TradeStation redirects the browser here as a top-level navigation after the
  // user authorizes — it carries no session token, so the callback is public.
  // The handler only exchanges an opaque one-time code for tokens.
  '/api/exchanges/v2/callback/tradestation',
])

export function isPublicApiPath(path: string): boolean {
  return PUBLIC_API_PATHS.has(path)
}
