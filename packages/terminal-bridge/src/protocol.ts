/**
 * Terminal ⇄ Executor postMessage protocol (licence-free refactor §4.1–4.6).
 *
 * The online terminal (apps/frontend, holds the TV Charting Library) is embedded
 * as an iframe inside the local executor shell (apps/kaibot-executor). Under the
 * carve-out the EXECUTOR owns the live state (positions, fills, bot configs); the
 * server has none. So data flows:
 *
 *   executor host  ──(EXECUTOR_OUT)──►  embedded terminal iframe   (plot fills/positions on the chart, LOCAL — "nothing rolls back")
 *   embedded iframe ──(TERMINAL_OUT)─►  executor host              (deploy / arm / start-stop / take-over → executor LOCAL api)
 *
 * Everything here is pure data + pure (de)serialisers + an origin guard. No DOM,
 * no window access at module scope, so it is fully unit-testable headless and
 * shared by both sides (one copy of the contract).
 */

/** Bumped on any breaking change to a payload shape. Receivers reject mismatches. */
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

/** Discriminator so a peer can ignore unrelated postMessages on the same window. */
export const BRIDGE_CHANNEL = 'kaibot-terminal-bridge' as const;

// ---------------------------------------------------------------------------
// Shared payload value types
// ---------------------------------------------------------------------------

export type PositionSide = 'long' | 'short';

/**
 * A live position as the executor knows it (aggregated from the connected
 * exchange sessions). Numeric fields are real numbers here — the executor
 * normalises before sending, so the terminal does not re-parse exchange strings.
 */
export interface BridgePosition {
  /** Stable id for the position (exchange position id or synthesised). */
  id: string;
  /** Exchange name as the executor reports it (e.g. "bybit"). */
  exchange: string;
  /** Instrument symbol (e.g. "BTCUSDT"). */
  symbol: string;
  side: PositionSide;
  /** Position size in base units; 0 means flat (filtered out before sending). */
  size: number;
  /** Average entry price, null while the open fill is still pending. */
  entryPrice: number | null;
  markPrice?: number | null;
  unrealizedPnl?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** The signal/bot id managing this position, if any (drives take-over). */
  signalId?: string | null;
}

/** A single fill the executor recorded locally (stays local, never to the server). */
export interface BridgeFill {
  id: string;
  signalId: string;
  exchange: string;
  symbol: string;
  /** Side of the POSITION this fill belongs to, not the order side. */
  side: PositionSide;
  /** Entry opens/adds to the position, exit reduces/closes it. */
  kind: 'entry' | 'exit';
  price: number;
  size: number;
  /** epoch ms */
  timestamp: number;
  commission?: number | null;
  accountId?: string | null;
}

export type BridgeBotStatus = 'running' | 'paused' | 'stopped';

/** A bot config row projected for the terminal's management panel. */
export interface BridgeBot {
  id: string;
  signalBotId?: string | null;
  strategy?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  status: BridgeBotStatus;
  executionTarget?: 'kaibot' | 'webhook' | null;
}

/** Coarse executor health/connection summary for the terminal status pill. */
export interface BridgeStatus {
  /** Executor reachable + healthy. */
  online: boolean;
  /** Global halt engaged (POST /api/ops/halt) — no new entries open. */
  halted: boolean;
  /** Number of connected exchange sessions. */
  connectedExchanges: number;
  executorVersion?: string | null;
}

// ---------------------------------------------------------------------------
// executor → iframe  (data push)
// ---------------------------------------------------------------------------

export type ExecutorOutKind = 'positions' | 'fills' | 'status' | 'botList' | 'hello';

interface BaseMessage<TDir extends 'executor' | 'terminal'> {
  channel: typeof BRIDGE_CHANNEL;
  v: typeof BRIDGE_PROTOCOL_VERSION;
  /** Which peer sent it. Guards against a peer reacting to its own echo. */
  dir: TDir;
}

export interface PositionsMessage extends BaseMessage<'executor'> {
  kind: 'positions';
  positions: BridgePosition[];
}

export interface FillsMessage extends BaseMessage<'executor'> {
  kind: 'fills';
  fills: BridgeFill[];
}

export interface StatusMessage extends BaseMessage<'executor'> {
  kind: 'status';
  status: BridgeStatus;
}

export interface BotListMessage extends BaseMessage<'executor'> {
  kind: 'botList';
  bots: BridgeBot[];
}

/** Handshake the executor sends once the iframe signals it is ready. */
export interface HelloMessage extends BaseMessage<'executor'> {
  kind: 'hello';
  executorVersion?: string | null;
}

export type ExecutorOutMessage =
  | PositionsMessage
  | FillsMessage
  | StatusMessage
  | BotListMessage
  | HelloMessage;

// ---------------------------------------------------------------------------
// iframe → executor  (command)
// ---------------------------------------------------------------------------

export type TerminalOutKind =
  | 'ready'
  | 'deployBot'
  | 'armBot'
  | 'startBot'
  | 'stopBot'
  | 'takeOver'
  | 'detachSignal';

/** Terminal announces it mounted and is ready to receive snapshots. */
export interface ReadyMessage extends BaseMessage<'terminal'> {
  kind: 'ready';
}

/** Create + persist a new bot from the terminal builder, then (optionally) arm it. */
export interface DeployBotMessage extends BaseMessage<'terminal'> {
  kind: 'deployBot';
  /** Opaque bot definition the executor persists via its bots route. */
  bot: {
    signalBotId?: string;
    strategy: string;
    symbol: string;
    timeframe: string;
    executionTarget?: 'kaibot' | 'webhook';
    alertWebhookUrl?: string;
    alertPayloadTemplate?: string;
  };
  /** When true, start it immediately after create. */
  arm?: boolean;
}

/** Arm (start) an existing bot — alias of startBot kept distinct for UX intent. */
export interface ArmBotMessage extends BaseMessage<'terminal'> {
  kind: 'armBot';
  botId: string;
}

export interface StartBotMessage extends BaseMessage<'terminal'> {
  kind: 'startBot';
  botId: string;
}

export interface StopBotMessage extends BaseMessage<'terminal'> {
  kind: 'stopBot';
  botId: string;
}

/**
 * Take over a position from its strategy/bot manager so it reverts to manual on
 * the edge. Identified by the managing bot id and/or the position id.
 */
export interface TakeOverMessage extends BaseMessage<'terminal'> {
  kind: 'takeOver';
  botId?: string;
  positionId?: string;
}

/** "Stop listening to a signal id" — detach a bot so its position goes manual. */
export interface DetachSignalMessage extends BaseMessage<'terminal'> {
  kind: 'detachSignal';
  botId: string;
}

export type TerminalOutMessage =
  | ReadyMessage
  | DeployBotMessage
  | ArmBotMessage
  | StartBotMessage
  | StopBotMessage
  | TakeOverMessage
  | DetachSignalMessage;

export type BridgeMessage = ExecutorOutMessage | TerminalOutMessage;
