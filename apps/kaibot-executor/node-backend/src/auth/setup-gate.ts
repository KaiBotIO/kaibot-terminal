// First-run /api/auth/setup gate (web/Docker mode). Desktop binds
// loopback-only and trusts the local caller, but a network-served executor
// must not let whoever races first claim the admin account: require the
// operator-set setup token (EXECUTOR_SETUP_TOKEN) when configured, otherwise
// accept the request only from loopback.

export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

export interface SetupGateInput {
  isDesktop: boolean
  setupToken: string | undefined // EXECUTOR_SETUP_TOKEN
  providedToken: string | undefined // x-setup-token header
  remoteAddress: string | undefined
}

export type SetupGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'bad_token' | 'not_loopback' }

export function checkSetupGate(input: SetupGateInput): SetupGateResult {
  if (input.isDesktop) return { allowed: true } // loopback-only sidecar
  if (input.setupToken) {
    return input.providedToken === input.setupToken
      ? { allowed: true }
      : { allowed: false, reason: 'bad_token' }
  }
  return isLoopbackAddress(input.remoteAddress)
    ? { allowed: true }
    : { allowed: false, reason: 'not_loopback' }
}
