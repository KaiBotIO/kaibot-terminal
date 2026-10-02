import { Hono } from 'hono'
import type { KaiBotDatabase } from '../storage/database.js'
import type { BotConfigRow } from '../storage/types.js'
import { detachBot, BotNotFoundError } from '../services/bot-detach.js'

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// Stable DTO the embedded terminal consumes — an identity/routing projection of
// BotConfigRow. Never carries strategy/indicator code: that lives only on the
// server (the brain). Status is the single field start/stop flips.
export interface BotDto {
  id: string
  signalBotId: string
  botName: string | null
  strategyId: string
  strategyName: string | null
  strategyType: string
  exchange: string
  symbol: string
  timeframe: string
  status: 'running' | 'paused' | 'stopped'
  executionTarget: 'kaibot' | 'webhook'
  alertWebhookUrl: string | null
}

export function toBotDto(cfg: BotConfigRow): BotDto {
  return {
    id: cfg.id,
    signalBotId: cfg.signalBotId,
    botName: cfg.botName ?? null,
    strategyId: cfg.strategyId,
    strategyName: cfg.strategyName ?? null,
    strategyType: cfg.strategyType,
    exchange: cfg.exchange,
    symbol: cfg.symbol,
    timeframe: cfg.timeframe,
    status: cfg.status,
    executionTarget: cfg.executionTarget,
    alertWebhookUrl: cfg.alertWebhookUrl ?? null,
  }
}

/**
 * Bot CONTROL PLANE for the embedded terminal.
 *
 * Exposes the executor's own bot_configs as a list + per-bot start/stop, and a
 * per-bot TAKE-OVER/detach that releases the local managers steering the bot's
 * positions so they revert to manual on the edge. Start/stop is a single
 * setBotConfigStatus call; take-over runs the pure planTakeOver decision
 * (services/take-over.ts) and applies the edge-side effects (pause the bot +
 * retire its active local trails). No close/cancel happens here — only WHO
 * manages the exit changes. The executor runs NO strategy/indicator code: these
 * rows are an identity/routing projection synced from the server (the brain).
 */
export function createBotRoutes(db: KaiBotDatabase, onMutation?: () => void) {
  const app = new Hono()

  // ── List all bots (running, paused, stopped) ──
  app.get('/', (c) => {
    try {
      const bots = db.getBotConfigs(false).map(toBotDto)
      return c.json({ bots })
    } catch (error) {
      db.log('error', 'system', 'Failed to list bots', { error: errMsg(error) })
      return c.json({ error: 'Failed to list bots' }, 500)
    }
  })

  // ── Single bot ──
  app.get('/:id', (c) => {
    const id = c.req.param('id')
    try {
      const cfg = db.getBotConfig(id)
      if (!cfg) return c.json({ error: 'not found' }, 404)
      return c.json(toBotDto(cfg))
    } catch (error) {
      db.log('error', 'system', 'Failed to get bot', { id, error: errMsg(error) })
      return c.json({ error: 'Failed to get bot' }, 500)
    }
  })

  // ── Start a bot: status → running. The server (the brain) decides whether to
  //    emit signals for it; the executor only flips local listening state. ──
  app.post('/:id/start', async (c) => {
    const id = c.req.param('id')
    try {
      const cfg = db.getBotConfig(id)
      if (!cfg) return c.json({ error: 'not found' }, 404)
      db.setBotConfigStatus(id, 'running')
      db.log('info', 'system', 'Bot started', { botConfigId: id })
      onMutation?.()
      const updated = db.getBotConfig(id)
      return c.json(updated ? toBotDto(updated) : { id, status: 'running' })
    } catch (error) {
      db.log('error', 'system', 'Failed to start bot', { id, error: errMsg(error) })
      return c.json({ error: 'Failed to start bot' }, 500)
    }
  })

  // ── Stop a bot: status → stopped. The executor stops listening for its
  //    signals. Open positions are NOT closed — use take-over/detach (or panic)
  //    to release their managers. ──
  app.post('/:id/stop', (c) => {
    const id = c.req.param('id')
    try {
      const cfg = db.getBotConfig(id)
      if (!cfg) return c.json({ error: 'not found' }, 404)
      db.setBotConfigStatus(id, 'stopped')
      db.log('info', 'system', 'Bot stopped', { botConfigId: id })
      onMutation?.()
      const updated = db.getBotConfig(id)
      return c.json(updated ? toBotDto(updated) : { id, status: 'stopped' })
    } catch (error) {
      db.log('error', 'system', 'Failed to stop bot', { id, error: errMsg(error) })
      return c.json({ error: 'Failed to stop bot' }, 500)
    }
  })

  // ── Take-over / detach a bot from the position(s) it manages ──
  // "Stop listening to this bot": pause the bot config so the executor stops
  // acting on its signals, and retire its active local trails so the position
  // reverts to manual on the edge. Runs the pure planTakeOver decision first; a no-op
  // (already manual, no managers) returns needed:false without writing.
  app.post('/:id/detach', (c) => {
    const id = c.req.param('id')
    try {
      const result = detachBot(db, id)
      onMutation?.()
      return c.json(result)
    } catch (error) {
      if (error instanceof BotNotFoundError) return c.json({ error: 'not found' }, 404)
      db.log('error', 'trading', 'Failed to detach bot', { id, error: errMsg(error) })
      return c.json({ error: 'Failed to detach bot' }, 500)
    }
  })

  return app
}
