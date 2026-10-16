import { describe, expect, it } from 'bun:test';
import {
  buildExecutorMessage,
  buildTerminalMessage,
  isOriginAllowed,
  parseBridgeMessage,
} from '../serde.js';
import { BRIDGE_CHANNEL, BRIDGE_PROTOCOL_VERSION } from '../protocol.js';

const TERMINAL_ORIGIN = 'https://terminal.kaibot.app';
const guard = { allowed: [TERMINAL_ORIGIN] } as const;

describe('origin guard', () => {
  it('allows an exact origin', () => {
    expect(isOriginAllowed(guard, TERMINAL_ORIGIN)).toBe(true);
  });
  it('rejects a foreign origin', () => {
    expect(isOriginAllowed(guard, 'https://evil.example')).toBe(false);
  });
  it('wildcard allows any origin', () => {
    expect(isOriginAllowed({ allowed: ['*'] }, 'https://anything')).toBe(true);
  });
});

describe('parseBridgeMessage — executor → terminal (host receiving terminal cmds)', () => {
  const make = (overrides: Record<string, unknown> = {}) => ({
    origin: TERMINAL_ORIGIN,
    data: buildTerminalMessage({ kind: 'startBot', botId: 'b1' }),
    ...overrides,
  });

  it('parses a valid terminal command when expecting terminal dir', () => {
    const res = parseBridgeMessage(make(), guard, 'terminal');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.kind).toBe('startBot');
  });

  it('rejects foreign origin', () => {
    const res = parseBridgeMessage(make({ origin: 'https://evil.example' }), guard, 'terminal');
    expect(res).toEqual({ ok: false, reason: 'origin-not-allowed' });
  });

  it('rejects non-object data', () => {
    const res = parseBridgeMessage({ origin: TERMINAL_ORIGIN, data: 'nope' }, guard, 'terminal');
    expect(res).toEqual({ ok: false, reason: 'not-an-object' });
  });

  it('rejects wrong channel', () => {
    const res = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: { channel: 'other', v: 1, dir: 'terminal', kind: 'startBot', botId: 'b1' } },
      guard,
      'terminal',
    );
    expect(res).toEqual({ ok: false, reason: 'wrong-channel' });
  });

  it('rejects version mismatch', () => {
    const res = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: { channel: BRIDGE_CHANNEL, v: 999, dir: 'terminal', kind: 'startBot', botId: 'b1' } },
      guard,
      'terminal',
    );
    expect(res).toEqual({ ok: false, reason: 'version-mismatch' });
  });

  it('rejects an echo of our own direction (wrong-direction)', () => {
    // Host posts an executor-dir message; if it arrives back, host must not act.
    const res = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: buildExecutorMessage({ kind: 'status', status: { online: true, halted: false, connectedExchanges: 1 } }) },
      guard,
      'terminal',
    );
    expect(res).toEqual({ ok: false, reason: 'wrong-direction' });
  });

  it('rejects unknown kind', () => {
    const res = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: { channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'terminal', kind: 'frobnicate' } },
      guard,
      'terminal',
    );
    expect(res).toEqual({ ok: false, reason: 'unknown-kind' });
  });

  it('rejects invalid payload (startBot without botId)', () => {
    const res = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: { channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'terminal', kind: 'startBot' } },
      guard,
      'terminal',
    );
    expect(res).toEqual({ ok: false, reason: 'invalid-payload' });
  });

  it('takeOver accepts botId-only or positionId-only', () => {
    const a = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: buildTerminalMessage({ kind: 'takeOver', botId: 'b1' }) },
      guard,
      'terminal',
    );
    const b = parseBridgeMessage(
      { origin: TERMINAL_ORIGIN, data: buildTerminalMessage({ kind: 'takeOver', positionId: 'p1' }) },
      guard,
      'terminal',
    );
    expect(a.ok && b.ok).toBe(true);
  });
});

describe('parseBridgeMessage — terminal → executor (iframe receiving data)', () => {
  it('parses positions snapshot', () => {
    const res = parseBridgeMessage(
      { origin: 'http://127.0.0.1:8080', data: buildExecutorMessage({ kind: 'positions', positions: [] }) },
      { allowed: ['http://127.0.0.1:8080'] },
      'executor',
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.kind).toBe('positions');
  });

  it('rejects a terminal command when expecting executor data', () => {
    const res = parseBridgeMessage(
      { origin: 'http://127.0.0.1:8080', data: buildTerminalMessage({ kind: 'startBot', botId: 'b1' }) },
      { allowed: ['http://127.0.0.1:8080'] },
      'executor',
    );
    expect(res).toEqual({ ok: false, reason: 'wrong-direction' });
  });
});

describe('builders stamp the envelope', () => {
  it('executor builder', () => {
    const m = buildExecutorMessage({ kind: 'fills', fills: [] });
    expect(m).toMatchObject({ channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'executor', kind: 'fills' });
  });
  it('terminal builder', () => {
    const m = buildTerminalMessage({ kind: 'detachSignal', botId: 'b1' });
    expect(m).toMatchObject({ channel: BRIDGE_CHANNEL, v: BRIDGE_PROTOCOL_VERSION, dir: 'terminal', kind: 'detachSignal' });
  });
});
