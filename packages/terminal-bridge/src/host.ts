/**
 * Executor-host side of the bridge. Lives in the executor shell (the parent
 * document that owns the iframe). Posts data snapshots INTO the iframe and
 * routes inbound terminal commands to handlers (which call the executor LOCAL
 * api). The window/iframe surface is injected so the routing is unit-testable
 * without a real DOM.
 */

import {
  type BridgeBot,
  type BridgeFill,
  type BridgePosition,
  type BridgeStatus,
  type DeployBotMessage,
  type TerminalOutMessage,
} from './protocol.js';
import {
  buildExecutorMessage,
  isOriginAllowed,
  parseBridgeMessage,
  type ExecutorOutBody,
  type OriginGuard,
  type ParseRejectReason,
} from './serde.js';

/** Minimal contract over an iframe's contentWindow we need to post into it. */
export interface PostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** Handlers the host wires to the executor LOCAL api (Task A routes). */
export interface HostCommandHandlers {
  onDeployBot?(msg: DeployBotMessage): void | Promise<void>;
  onArmBot?(botId: string): void | Promise<void>;
  onStartBot?(botId: string): void | Promise<void>;
  onStopBot?(botId: string): void | Promise<void>;
  onTakeOver?(arg: { botId?: string; positionId?: string }): void | Promise<void>;
  onDetachSignal?(botId: string): void | Promise<void>;
  /** Terminal mounted and is ready for an initial snapshot push. */
  onReady?(): void | Promise<void>;
  /** Observability hook for rejected/foreign messages. */
  onReject?(reason: ParseRejectReason, raw: { origin: string; data: unknown }): void;
}

export interface HostBridgeOptions {
  /** Where to post snapshots — the iframe's contentWindow. */
  target: PostTarget;
  /**
   * The origin the iframe is served from (the online terminal origin). Used both
   * as the postMessage targetOrigin and as the inbound origin allowlist.
   */
  terminalOrigin: string;
  handlers: HostCommandHandlers;
  executorVersion?: string | null;
}

/**
 * Routes one already-parsed terminal command to the right handler. Exposed
 * separately so the routing table is testable without window plumbing.
 */
export function routeTerminalMessage(
  msg: TerminalOutMessage,
  handlers: HostCommandHandlers,
): void | Promise<void> {
  switch (msg.kind) {
    case 'ready':
      return handlers.onReady?.();
    case 'deployBot':
      return handlers.onDeployBot?.(msg);
    case 'armBot':
      return handlers.onArmBot?.(msg.botId);
    case 'startBot':
      return handlers.onStartBot?.(msg.botId);
    case 'stopBot':
      return handlers.onStopBot?.(msg.botId);
    case 'takeOver':
      return handlers.onTakeOver?.({ botId: msg.botId, positionId: msg.positionId });
    case 'detachSignal':
      return handlers.onDetachSignal?.(msg.botId);
    default: {
      // Exhaustiveness guard — a new kind without a case is a compile error.
      const _never: never = msg;
      return _never;
    }
  }
}

export class ExecutorHostBridge {
  private readonly target: PostTarget;
  private readonly terminalOrigin: string;
  private readonly handlers: HostCommandHandlers;
  private readonly guard: OriginGuard;
  private readonly executorVersion: string | null;

  constructor(opts: HostBridgeOptions) {
    this.target = opts.target;
    this.terminalOrigin = opts.terminalOrigin;
    this.handlers = opts.handlers;
    this.executorVersion = opts.executorVersion ?? null;
    this.guard = { allowed: [opts.terminalOrigin] };
  }

  /** Feed a raw window 'message' event in. Parses, guards, routes. */
  handleIncoming(raw: { origin: string; data: unknown }): void {
    const res = parseBridgeMessage(raw, this.guard, 'terminal');
    if (!res.ok) {
      this.handlers.onReject?.(res.reason, raw);
      return;
    }
    void routeTerminalMessage(res.message, this.handlers);
  }

  private post(body: ExecutorOutBody): void {
    // Foreign origins can't receive — targetOrigin pins delivery to the terminal.
    if (!isOriginAllowed(this.guard, this.terminalOrigin)) return;
    this.target.postMessage(buildExecutorMessage(body), this.terminalOrigin);
  }

  sendHello(): void {
    this.post({ kind: 'hello', executorVersion: this.executorVersion });
  }

  sendPositions(positions: BridgePosition[]): void {
    this.post({ kind: 'positions', positions });
  }

  sendFills(fills: BridgeFill[]): void {
    this.post({ kind: 'fills', fills });
  }

  sendStatus(status: BridgeStatus): void {
    this.post({ kind: 'status', status });
  }

  sendBotList(bots: BridgeBot[]): void {
    this.post({ kind: 'botList', bots });
  }
}
