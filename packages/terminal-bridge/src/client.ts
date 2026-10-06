/**
 * Terminal-iframe side of the bridge. Lives in the online terminal (apps/frontend)
 * when it runs embedded. Receives executor data snapshots and exposes a small
 * command emitter (deploy/arm/start/stop/take-over) back to the host. Window
 * surfaces are injected so the routing is unit-testable.
 */

import {
  type BridgeBot,
  type BridgeFill,
  type BridgePosition,
  type BridgeStatus,
  type ExecutorOutMessage,
} from './protocol.js';
import {
  buildTerminalMessage,
  parseBridgeMessage,
  type OriginGuard,
  type ParseRejectReason,
  type TerminalOutBody,
} from './serde.js';
import type { DeployBotMessage } from './protocol.js';

/** Minimal contract over window.parent we need to post commands out. */
export interface ParentPostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface TerminalDataHandlers {
  onPositions?(positions: BridgePosition[]): void;
  onFills?(fills: BridgeFill[]): void;
  onStatus?(status: BridgeStatus): void;
  onBotList?(bots: BridgeBot[]): void;
  onHello?(executorVersion?: string | null): void;
  onReject?(reason: ParseRejectReason, raw: { origin: string; data: unknown }): void;
}

export interface TerminalClientOptions {
  parent: ParentPostTarget;
  /** Origin of the executor host (the loopback daemon / tauri origin). */
  executorOrigin: string;
  handlers: TerminalDataHandlers;
}

/** Routes one parsed executor message to the right data handler. Testable. */
export function routeExecutorMessage(
  msg: ExecutorOutMessage,
  handlers: TerminalDataHandlers,
): void {
  switch (msg.kind) {
    case 'positions':
      handlers.onPositions?.(msg.positions);
      return;
    case 'fills':
      handlers.onFills?.(msg.fills);
      return;
    case 'status':
      handlers.onStatus?.(msg.status);
      return;
    case 'botList':
      handlers.onBotList?.(msg.bots);
      return;
    case 'hello':
      handlers.onHello?.(msg.executorVersion);
      return;
    default: {
      const _never: never = msg;
      return _never;
    }
  }
}

export class TerminalClientBridge {
  private readonly parent: ParentPostTarget;
  private readonly executorOrigin: string;
  private readonly handlers: TerminalDataHandlers;
  private readonly guard: OriginGuard;

  constructor(opts: TerminalClientOptions) {
    this.parent = opts.parent;
    this.executorOrigin = opts.executorOrigin;
    this.handlers = opts.handlers;
    this.guard = { allowed: [opts.executorOrigin] };
  }

  handleIncoming(raw: { origin: string; data: unknown }): void {
    const res = parseBridgeMessage(raw, this.guard, 'executor');
    if (!res.ok) {
      this.handlers.onReject?.(res.reason, raw);
      return;
    }
    routeExecutorMessage(res.message, this.handlers);
  }

  private send(body: TerminalOutBody): void {
    this.parent.postMessage(buildTerminalMessage(body), this.executorOrigin);
  }

  /** Announce the iframe is mounted and ready for an initial snapshot. */
  sendReady(): void {
    this.send({ kind: 'ready' });
  }

  deployBot(bot: DeployBotMessage['bot'], arm = false): void {
    this.send({ kind: 'deployBot', bot, arm });
  }

  armBot(botId: string): void {
    this.send({ kind: 'armBot', botId });
  }

  startBot(botId: string): void {
    this.send({ kind: 'startBot', botId });
  }

  stopBot(botId: string): void {
    this.send({ kind: 'stopBot', botId });
  }

  takeOver(arg: { botId?: string; positionId?: string }): void {
    this.send({ kind: 'takeOver', ...arg });
  }

  detachSignal(botId: string): void {
    this.send({ kind: 'detachSignal', botId });
  }
}
