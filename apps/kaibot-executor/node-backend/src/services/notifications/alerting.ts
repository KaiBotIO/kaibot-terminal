// External alerting (parity #8 with kaibot-exec gchat alerts).
//
// Bridges the in-process NotificationBus to a configured outbound webhook
// (Google Chat / Slack-compatible: POST {text}) and runs a health monitor that
// re-alerts while the signal service stays down, with a recovery message when
// it comes back. The webhook URL lives in user settings (alerting.webhookUrl)
// so it survives restarts and is editable from the Settings UI.
//
// Design rules:
//  - alerting NEVER blocks or breaks the order flow (fire-and-forget sends);
//  - only operationally meaningful events are forwarded (order-fail, settlement
//    timeout, reconciler large-mismatch / foreign-order, signal-service down);
//  - the signal-service-down alert repeats every N minutes until recovery.

import type { KaiBotDatabase } from '../../storage/database.js'
import type { NotificationBus, NotificationEvent } from './notification-bus.js'
import { sendWebhook } from './webhook-sender.js'

const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS) || 60 * 1000
// While the signal service stays down, re-send the alert this often.
const DOWN_REALERT_MS = Number(process.env.DOWN_REALERT_MS) || 5 * 60 * 1000

export interface AlertingConfig {
  webhookUrl?: string
  enabled?: boolean
}

export interface AlertingDeps {
  db: KaiBotDatabase
  bus: NotificationBus
  // Liveness probe for the upstream signal service (the WS client).
  isSignalServiceConnected: () => boolean
  // Override for tests; defaults to reading user settings.
  getConfig?: () => AlertingConfig
  sendImpl?: typeof sendWebhook
}

// Notification event types that should leave the box as an external alert.
// Routine fills/connections stay in-app; this is the "wake someone up" subset.
// synthetic_rebalanced is an autonomous real-money order — always webhooked.
const ALERTABLE = new Set<NotificationEvent['type']>([
  'order_rejected',
  'error',
  'synthetic_rebalanced',
])

export class AlertingService {
  private listener: ((e: NotificationEvent) => void) | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private lastHealthy: boolean | null = null
  private lastDownAlertAt = 0

  constructor(private deps: AlertingDeps) {}

  private config(): AlertingConfig {
    if (this.deps.getConfig) return this.deps.getConfig()
    try {
      const user = this.deps.db.getAdminUser()
      const settings = user?.settings ? JSON.parse(user.settings) : {}
      const a = settings.alerting ?? {}
      return { webhookUrl: a.webhookUrl, enabled: a.enabled }
    } catch {
      return {}
    }
  }

  // Whether alerting is active (configured + enabled). When no explicit enabled
  // flag is stored, a present URL implies enabled.
  isActive(): boolean {
    const c = this.config()
    if (!c.webhookUrl) return false
    return c.enabled !== false
  }

  start(): void {
    if (this.listener) return
    this.listener = (e: NotificationEvent) => {
      if (!ALERTABLE.has(e.type)) return
      this.dispatch(`KaiBot Terminal: ${e.title} — ${e.body}`)
    }
    this.deps.bus.on('notification', this.listener)
    this.healthTimer = setInterval(() => void this.healthTick(), HEALTH_INTERVAL_MS)
  }

  stop(): void {
    if (this.listener) {
      this.deps.bus.off('notification', this.listener)
      this.listener = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  // Fire-and-forget send; logs failures but never throws to the caller.
  dispatch(text: string): void {
    if (!this.isActive()) return
    const url = this.config().webhookUrl!
    const send = this.deps.sendImpl ?? sendWebhook
    void send(url, text)
      .then((r) => {
        if (!r.ok) {
          this.deps.db.log('warn', 'system', 'Alert webhook failed', {
            attempts: r.attempts,
            error: r.error,
            status: r.status,
          })
        }
      })
      .catch((err) => {
        this.deps.db.log('warn', 'system', 'Alert webhook threw', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  // Send a one-shot test alert; awaitable so the Settings UI can show a result.
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const c = this.config()
    if (!c.webhookUrl) return { ok: false, error: 'no webhook URL configured' }
    const send = this.deps.sendImpl ?? sendWebhook
    const r = await send(c.webhookUrl, 'KaiBot Terminal: test alert — alerting is wired up correctly.')
    return { ok: r.ok, error: r.ok ? undefined : r.error }
  }

  // Re-alert on signal-service down every DOWN_REALERT_MS, recovery once.
  async healthTick(): Promise<void> {
    if (!this.isActive()) return
    const healthy = this.deps.isSignalServiceConnected()
    const now = Date.now()

    if (healthy) {
      if (this.lastHealthy === false) {
        this.dispatch('KaiBot Terminal: signal service is back. Signals will execute again.')
      }
      this.lastHealthy = true
      this.lastDownAlertAt = 0
      return
    }

    if (this.lastHealthy !== false || now - this.lastDownAlertAt >= DOWN_REALERT_MS) {
      this.dispatch(
        "KaiBot Terminal: signal service is down. Incoming signals won't execute until it's back.",
      )
      this.lastDownAlertAt = now
    }
    this.lastHealthy = false
  }
}
