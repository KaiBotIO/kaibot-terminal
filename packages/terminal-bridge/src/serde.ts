/**
 * Pure (de)serialisation + origin guard for the terminal⇄executor bridge.
 *
 * Receivers MUST run every inbound MessageEvent through {@link parseBridgeMessage}
 * with an explicit origin allowlist before acting. The parser rejects:
 *   - foreign origins (anything not in the allowlist),
 *   - non-bridge messages (wrong/absent channel),
 *   - protocol-version mismatches,
 *   - wrong direction (a peer must never act on its own echoed message),
 *   - structurally invalid payloads.
 *
 * No window/DOM access here so it stays unit-testable headless.
 */

import {
  BRIDGE_CHANNEL,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  type ExecutorOutMessage,
  type TerminalOutMessage,
} from './protocol.js';

/** Outcome of parsing an inbound MessageEvent. Discriminated, never throws. */
export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: ParseRejectReason };

export type ParseRejectReason =
  | 'origin-not-allowed'
  | 'not-an-object'
  | 'wrong-channel'
  | 'version-mismatch'
  | 'wrong-direction'
  | 'unknown-kind'
  | 'invalid-payload';

/**
 * Normalise an origin allowlist entry for comparison. A `'*'` entry means
 * "any origin" and is intended only for trusted same-machine setups (the
 * executor loopback daemon). Prefer explicit origins.
 */
export interface OriginGuard {
  /** Exact origins (scheme://host[:port]) allowed, or `'*'` to allow any. */
  allowed: readonly string[];
}

export function isOriginAllowed(guard: OriginGuard, origin: string): boolean {
  if (guard.allowed.includes('*')) return true;
  return guard.allowed.includes(origin);
}

const EXECUTOR_KINDS = new Set(['positions', 'fills', 'status', 'botList', 'hello']);
const TERMINAL_KINDS = new Set([
  'ready',
  'deployBot',
  'armBot',
  'startBot',
  'stopBot',
  'takeOver',
  'detachSignal',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function envelopeOk(data: Record<string, unknown>): boolean {
  return data.channel === BRIDGE_CHANNEL && data.v === BRIDGE_PROTOCOL_VERSION;
}

/** Validate the kind-specific body. Kept conservative — reject on anything odd. */
function payloadValid(data: Record<string, unknown>): boolean {
  switch (data.kind) {
    case 'positions':
      return Array.isArray(data.positions);
    case 'fills':
      return Array.isArray(data.fills);
    case 'botList':
      return Array.isArray(data.bots);
    case 'status':
      return isRecord(data.status);
    case 'hello':
    case 'ready':
      return true;
    case 'deployBot':
      return isRecord(data.bot) && typeof (data.bot as Record<string, unknown>).strategy === 'string';
    case 'armBot':
    case 'startBot':
    case 'stopBot':
    case 'detachSignal':
      return typeof data.botId === 'string' && data.botId.length > 0;
    case 'takeOver':
      return typeof data.botId === 'string' || typeof data.positionId === 'string';
    default:
      return false;
  }
}

/**
 * Parse a raw inbound event into a typed bridge message of the expected
 * direction. `expectDir` is the direction the CALLER expects to receive:
 * the terminal expects `'executor'` messages, the executor expects `'terminal'`.
 */
export function parseBridgeMessage<TDir extends 'executor' | 'terminal'>(
  raw: { origin: string; data: unknown },
  guard: OriginGuard,
  expectDir: TDir,
): ParseResult<TDir extends 'executor' ? ExecutorOutMessage : TerminalOutMessage> {
  if (!isOriginAllowed(guard, raw.origin)) return { ok: false, reason: 'origin-not-allowed' };
  const data = raw.data;
  if (!isRecord(data)) return { ok: false, reason: 'not-an-object' };
  if (data.channel !== BRIDGE_CHANNEL) return { ok: false, reason: 'wrong-channel' };
  if (!envelopeOk(data)) return { ok: false, reason: 'version-mismatch' };
  if (data.dir !== expectDir) return { ok: false, reason: 'wrong-direction' };

  const kindSet = expectDir === 'executor' ? EXECUTOR_KINDS : TERMINAL_KINDS;
  if (typeof data.kind !== 'string' || !kindSet.has(data.kind)) {
    return { ok: false, reason: 'unknown-kind' };
  }
  if (!payloadValid(data)) return { ok: false, reason: 'invalid-payload' };

  // Validated structurally; the discriminated union narrows on `kind` downstream.
  return {
    ok: true,
    message: data as unknown as TDir extends 'executor' ? ExecutorOutMessage : TerminalOutMessage,
  };
}

/** Envelope-less body of a message — distributes over the union so each kind keeps its own props. */
type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'channel' | 'v' | 'dir'> : never;

export type ExecutorOutBody = WithoutEnvelope<ExecutorOutMessage>;
export type TerminalOutBody = WithoutEnvelope<TerminalOutMessage>;

/** Stamp the channel/version/dir envelope onto a kind-specific body (executor side). */
export function buildExecutorMessage(body: ExecutorOutBody): ExecutorOutMessage {
  return { channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'executor', ...body } as ExecutorOutMessage;
}

/** Stamp the envelope onto a kind-specific body (terminal side). */
export function buildTerminalMessage(body: TerminalOutBody): TerminalOutMessage {
  return { channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'terminal', ...body } as TerminalOutMessage;
}

/** Convenience type guard usable after a successful parse on the executor host. */
export function isBridgeMessage(v: unknown): v is BridgeMessage {
  return isRecord(v) && v.channel === BRIDGE_CHANNEL && v.v === BRIDGE_PROTOCOL_VERSION;
}
