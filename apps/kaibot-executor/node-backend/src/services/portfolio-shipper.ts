// Ships local fills + equity snapshots to the server's opt-in analytics ingest.
//
// The executor is the source of truth for fills/equity; this shipper forwards
// them so the server can render real analytics. Consent is enforced on BOTH
// sides (R7): the server's ingest endpoints gate on the user's
// sharePortfolioData opt-in (default off), and the executor learns that gate
// state via an EMPTY probe batch before any real row leaves the machine — so
// "your fills stay on your machine until you turn this on" holds at the wire
// level, not just at the storage level. While opted out the shipper re-probes
// on a slow interval so flipping the toggle needs no executor restart.
//
// Exactly-once: each row carries a `synced` flag (migration 014); a row is
// marked synced only after the server confirms ingest, so a crash mid-ship
// re-sends rather than drops. Polls on an interval, mirroring BalanceSnapshotPoller.

import type { KaiBotDatabase } from '../storage/database.js'

const DEFAULT_SHIP_MS = 30_000
// While opted out, only an empty consent probe goes out, this often.
const OPT_OUT_REPROBE_MS = 10 * 60_000
const BATCH = 500

export interface ShipperDeps {
  // Resolve the API base URL (null until the signal client has connected).
  getApiUrl: () => string | null
  // Session token for the ingest endpoints (same as the ack path).
  getSessionToken?: () => string | undefined
  // Per-user API key (same as the WS). The server resolves the user from its
  // hash so ingest is attributed to the right account, not a shared secret.
  getApiKey?: () => string | null
}

export class PortfolioShipper {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly shipMs: number
  // EXEC-4: defensive local consent gate. The server already drops opted-out
  // data, but a 403 means "consent off / not allowed" — stop shipping until the
  // process restarts rather than re-POST every interval.
  private consentDenied = false
  // R7: consent as learned from the server's gate response. Real rows ship only
  // when 'granted'; otherwise only empty probes leave the machine.
  private consent: 'unknown' | 'granted' | 'opt-out' = 'unknown'
  private nextProbeAt = 0

  constructor(
    private db: KaiBotDatabase,
    private deps: ShipperDeps,
    opts?: { shipMs?: number },
  ) {
    this.shipMs = opts?.shipMs ?? DEFAULT_SHIP_MS
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.db.log('warn', 'system', 'PortfolioShipper tick failed', { error: err?.message })
      })
    }, this.shipMs)
    this.db.log('info', 'system', 'Portfolio shipper started', { shipMs: this.shipMs })
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // One pass: probe consent if needed, then ship unsynced fills and equity
  // snapshots. Public for tests.
  async tick(): Promise<{ fills: number; equity: number }> {
    if (this.consentDenied) return { fills: 0, equity: 0 }
    const apiUrl = this.deps.getApiUrl()
    const token = (this.deps.getSessionToken ?? (() => process.env.EXECUTOR_SESSION_TOKEN))()
    const apiKey = this.deps.getApiKey?.() ?? null
    // Need a destination and at least one credential (per-user key preferred).
    if (!apiUrl || (!token && !apiKey)) return { fills: 0, equity: 0 }

    const auth: AuthHeaders = {}
    if (apiKey) auth['x-api-key'] = apiKey
    if (token) auth['x-session-token'] = token

    // No real payload leaves the box until the server confirms the opt-in: an
    // EMPTY batch triggers the same consent gate and tells us its state.
    if (this.consent !== 'granted') {
      if (Date.now() < this.nextProbeAt) return { fills: 0, equity: 0 }
      const probe = await this.post(apiUrl, auth, '/api/portfolio/fills', { fills: [] })
      // Transient failure: stay 'unknown' and retry next tick, no long backoff.
      if (!probe.ok) return { fills: 0, equity: 0 }
      if (probe.optOut) {
        this.consent = 'opt-out'
        this.nextProbeAt = Date.now() + OPT_OUT_REPROBE_MS
        return { fills: 0, equity: 0 }
      }
      this.consent = 'granted'
      this.db.log('info', 'system', 'Portfolio sharing opt-in confirmed — shipping enabled')
    }

    const fills = await this.shipFills(apiUrl, auth)
    // Consent can be revoked mid-tick (opt-out on the fills batch, or a 403):
    // the equity snapshots must not go out in the same pass.
    if ((this.consent as string) !== 'granted' || this.consentDenied) {
      return { fills, equity: 0 }
    }
    const equity = await this.shipEquity(apiUrl, auth)
    return { fills, equity }
  }

  private async post(
    apiUrl: string,
    auth: AuthHeaders,
    path: string,
    body: unknown,
  ): Promise<{ ok: boolean; optOut: boolean }> {
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify(body),
      })
      if (res.status === 403) {
        // Consent off / not allowed: stop shipping for this process lifetime.
        this.consentDenied = true
        this.db.log('warn', 'system', 'Portfolio ingest denied (403) — stopping shipper', { path })
        return { ok: false, optOut: true }
      }
      if (!res.ok) {
        this.db.log('warn', 'system', 'Portfolio ingest POST failed', { path, status: res.status })
        return { ok: false, optOut: false }
      }
      // 200 with skipped/opt-out = the gate refused: the user flipped sharing
      // off. Fall back to probing so nothing real ships next tick.
      const parsed = (await res.json().catch(() => null)) as
        | { skipped?: boolean; reason?: string }
        | null
      if (parsed?.skipped && parsed.reason === 'opt-out') {
        return { ok: true, optOut: true }
      }
      return { ok: true, optOut: false }
    } catch (err: any) {
      this.db.log('warn', 'system', 'Portfolio ingest POST error', { path, error: err.message })
      return { ok: false, optOut: false }
    }
  }

  private async shipFills(apiUrl: string, auth: AuthHeaders): Promise<number> {
    const rows = this.db.listUnsyncedFills(BATCH)
    if (rows.length === 0) return 0
    const fills = rows.map((r) => ({
      signalId: r.signal_id,
      kind: r.kind,
      qty: r.qty,
      price: r.price,
      commission: r.commission,
      orderId: r.order_id,
      ts: r.created_at,
    }))
    const res = await this.post(apiUrl, auth, '/api/portfolio/fills', { fills })
    if (res.optOut) this.revokeConsent()
    if (!res.ok || res.optOut) return 0
    this.db.markFillsSynced(rows.map((r) => r.id))
    return rows.length
  }

  // The user flipped sharing off mid-flight: back to probe mode, nothing real
  // ships until the server confirms opt-in again.
  private revokeConsent() {
    if (this.consent === 'opt-out') return
    this.consent = 'opt-out'
    this.nextProbeAt = Date.now() + OPT_OUT_REPROBE_MS
    this.db.log('info', 'system', 'Portfolio sharing opted out — shipping paused')
  }

  private async shipEquity(apiUrl: string, auth: AuthHeaders): Promise<number> {
    const rows = this.db.listUnsyncedSnapshots(BATCH)
    if (rows.length === 0) return 0
    const snapshots = rows.map((r) => ({
      exchangeAccountId: r.account_id,
      equity: r.equity,
      balance: r.balance,
      unrealizedPnl: r.unrealized_pnl,
      currency: r.currency,
      ts: r.ts,
    }))
    const res = await this.post(apiUrl, auth, '/api/portfolio/equity', { snapshots })
    if (res.optOut) this.revokeConsent()
    if (!res.ok || res.optOut) return 0
    this.db.markSnapshotsSynced(rows.map((r) => r.id))
    return rows.length
  }
}

type AuthHeaders = Record<string, string>
