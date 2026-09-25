// TradeStation auth mode, resolved at RUNTIME so a single public build serves
// both audiences. OAuth is the default: the user fills in their own TradeStation
// API key + secret. The CouchDB path reads the access_token from Kai's legacy
// KaiBotWeb session and only works on the box that holds those credentials, so
// it activates only when that box's COUCHDB_* vars are present (or when the
// mode is forced). Pure so it's testable.

export type TradestationAuthMode = 'oauth' | 'couchdb'

export function resolveTradestationAuthMode(
  env: Record<string, string | undefined> = process.env,
): TradestationAuthMode {
  const forced = (env.TRADESTATION_AUTH_MODE ?? '').trim().toLowerCase()
  if (forced === 'couchdb' || forced === 'oauth') return forced

  // Dev override kept from the build-time switch; only 'true' has an effect, so
  // a stale `false` can never strand a user on the unusable CouchDB form.
  const legacy = (env.TRADESTATION_USE_OAUTH ?? env.VITE_TRADESTATION_USE_OAUTH ?? '').trim().toLowerCase()
  if (legacy === 'true') return 'oauth'

  return env.COUCHDB_URL && env.COUCHDB_TS_SESSION_ID ? 'couchdb' : 'oauth'
}
