import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { KaiBotDatabase } from '../storage/database.js'
import {
  RecoveryComposeError,
  type RecoveryComposeService,
} from '../services/recovery-compose.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// HTTP status per compose error, so the frontend can branch on the code
// without string-matching messages.
const STATUS: Record<RecoveryComposeError['code'], ContentfulStatusCode> = {
  'no-config': 400,
  unauthorized: 401,
  forbidden: 403,
  'rate-limited': 429,
  'bad-request': 400,
  unavailable: 502,
}

// Recovery-ladder composer for the manual panel. Proxies the protected server
// calculator (user's own kb_ key); the reply is rung prices + sizes the USER
// then reviews and places as F0 resting rungs — the executor decides nothing.
export function createComposeRecoveryRoutes(db: KaiBotDatabase, service: RecoveryComposeService) {
  const app = new Hono()

  app.post('/compose-recovery', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as {
        extreme?: number
        entry?: number
        totalQty?: number
        assetClass?: string
        levels?: number
        tickSize?: number
        sizeStep?: number
        includeRecoveryTail?: boolean
      } | null
      if (!body) return c.json({ error: 'JSON body required', code: 'bad-request' }, 400)

      const positives: Array<[string, unknown]> = [
        ['extreme', body.extreme],
        ['entry', body.entry],
        ['totalQty', body.totalQty],
      ]
      for (const [name, v] of positives) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          return c.json({ error: `${name} must be a positive number`, code: 'bad-request' }, 400)
        }
      }
      if (body.assetClass !== 'crypto' && body.assetClass !== 'tradfi') {
        return c.json({ error: "assetClass must be 'crypto' or 'tradfi'", code: 'bad-request' }, 400)
      }
      const optionals: Array<[string, unknown]> = [
        ['levels', body.levels],
        ['tickSize', body.tickSize],
        ['sizeStep', body.sizeStep],
      ]
      for (const [name, v] of optionals) {
        if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          return c.json({ error: `${name} must be a positive number`, code: 'bad-request' }, 400)
        }
      }

      const result = await service.compose({
        extreme: body.extreme as number,
        entry: body.entry as number,
        totalQty: body.totalQty as number,
        assetClass: body.assetClass,
        levels: body.levels,
        tickSize: body.tickSize,
        sizeStep: body.sizeStep,
        includeRecoveryTail: body.includeRecoveryTail === true,
      })
      return c.json(result)
    } catch (error) {
      if (error instanceof RecoveryComposeError) {
        return c.json({ error: error.message, code: error.code }, STATUS[error.code])
      }
      db.log('error', 'trading', 'Recovery compose failed', { error: errMsg(error) })
      return c.json({ error: errMsg(error), code: 'unavailable' }, 500)
    }
  })

  return app
}
