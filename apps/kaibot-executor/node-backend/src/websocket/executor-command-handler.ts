// Remote-companion command handler.
//
// The central API relays an opaque `blob`; this handler opens it (keyed by the
// pairing state), whitelist-validates the command, and dispatches to the EXISTING
// local services/db fns — no HTTP re-entry. The hard invariants:
//
//  1. Opt-in gate FIRST: if remote management is OFF → `companion_disabled`,
//     refused before anything else (the consent cornerstone).
//  2. Pairing window: while ENABLED, `pair` (UNSEALED) + `pairConfirm` (SEALED
//     with the pending session key) are accepted even when NOT-yet-paired — they
//     ARE the pairing handshake. Every OTHER command requires a verified paired
//     device → else `not_paired`, and is SEALED with the paired session key.
//  3. MiCA structural guarantee: ALLOWED_COMMANDS contains ONLY risk/config/
//     lifecycle ops. NO order-placement verb exists. The handler never places a
//     directional order — entries/exits/stops arrive exclusively as server
//     `signal` messages. (Asserted in a test.)
//
// Unknown type → `unknown_command`; bad payload / failed AEAD-open → `bad_payload`;
// a throwing op → `{ ok:false, error:<message> }`. Never crashes the socket.

import type { KaiBotDatabase } from '../storage/database.js';
import type { ExchangeManager } from '../services/exchanges/exchangeManager.js';
import type { CompanionService } from '../services/companion.js';
import { panicCloseAll } from '../services/panic.js';
import { detachBot, BotNotFoundError } from '../services/bot-detach.js';
import { assembleExecutorState } from '../services/state-snapshot.js';
import { isFuturesRoot } from '../services/exchanges/futures-contracts.js';
import { sizingRoot } from '../services/account-sizing.js';
import { open as openBlob, seal as sealBlob, type OpenedCommand } from '../companion/seal.js';

// The authoritative whitelist. EVERY entry is a risk / config / lifecycle op —
// there is deliberately NO order-placement command (no buy/sell/open/place/trade).
// Adding a directional-order verb here would break the MiCA guarantee; a test
// asserts this list stays order-free.
export const ALLOWED_COMMANDS = [
  'panic',
  'setHalt',
  'setGuardrails',
  'setAccountSizes',
  'botStart',
  'botStop',
  'botDetach',
  'subscriptionPause',
  'subscriptionResume',
  'getState',
] as const;

export type AllowedCommand = (typeof ALLOWED_COMMANDS)[number];

const ALLOWED_SET = new Set<string>(ALLOWED_COMMANDS);
// Pairing message types accepted DURING the opt-in window, before a paired device
// exists. Kept separate from ALLOWED_COMMANDS so the MiCA list stays command-only.
const PAIRING_TYPES = new Set<string>(['pair', 'pairConfirm']);

export interface CommandResult {
  ok: boolean;
  // The cleartext result object for a normal command. The caller (signal-client)
  // seals it into `resultBlob` with the paired key. Absent on the pairing path.
  result?: unknown;
  // A wire-ready reply blob the handler produced ITSELF (pairing path only):
  // PLAINTEXT for `pair` (executor pubkey, no channel yet), SEALED for
  // `pairConfirm`. When set, the caller forwards it verbatim and does NOT re-seal.
  resultBlob?: string;
  // CLEARTEXT short code (never sealed): companion_disabled | not_paired |
  // unknown_command | bad_payload | or a generic op message.
  error?: string;
  // True when the command changed local state (everything but a `getState` read,
  // plus a fresh pairConfirm). The caller nudges a state push when set.
  mutated?: boolean;
}

export interface ExecutorCommandDeps {
  db: KaiBotDatabase;
  exchangeManager: ExchangeManager | null;
  companion: CompanionService;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const nonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Handle one relayed companion command from its RAW blob. Owns the keyed open():
 * a `pair` blob is plaintext; a `pairConfirm`/command blob is AEAD-sealed with the
 * device session key. `cmdId` binds the AAD. Returns a CommandResult; never throws.
 */
export async function handleExecutorCommand(
  deps: ExecutorCommandDeps,
  blob: string,
  cmdId: string,
): Promise<CommandResult> {
  const { db, exchangeManager, companion } = deps;

  // (1) Opt-in gate — refuse before touching anything (covers pairing too).
  if (!companion.isCompanionEnabled()) {
    return { ok: false, error: 'companion_disabled' };
  }

  // (2) Pairing window. `pair` is UNSEALED (plaintext pubkey JSON); `pairConfirm`
  // is SEALED with the PENDING device's session key. We peek the unsealed shape
  // first to route pair, then route pairConfirm via the pending key.
  const pairing = await tryHandlePairing(deps, blob, cmdId);
  if (pairing) return pairing;

  // (3) Paired-device gate — every non-pairing command needs a verified device.
  if (!companion.hasPairedDevice()) {
    return { ok: false, error: 'not_paired' };
  }

  // (4) Open the SEALED command with the paired session key (aad = `${cmdId}:cmd`).
  const sessionKey = companion.pairedSessionKey();
  if (!sessionKey) return { ok: false, error: 'not_paired' };
  let opened: OpenedCommand;
  try {
    opened = openBlob(sessionKey, blob, `${cmdId}:cmd`);
  } catch {
    return { ok: false, error: 'bad_payload' };
  }

  const res = await dispatchCommand(deps, opened);
  // Everything but a read mutated local state → caller pushes a fresh snapshot.
  if (res.ok && opened.type !== 'getState') res.mutated = true;
  return res;
}

// Seal a successful command/state RESULT for the paired device. cmdId binds the
// aad to `${cmdId}:result`. Returns null when there's no paired key (shouldn't
// happen on a successful command path).
export function sealResult(companion: CompanionService, result: unknown, cmdId: string): string | null {
  const sessionKey = companion.pairedSessionKey();
  if (!sessionKey) return null;
  return sealBlob(sessionKey, result, `${cmdId}:result`);
}

// Route `pair` / `pairConfirm`. Returns a CommandResult when the blob IS a pairing
// message, or null to fall through to the command path. Never throws.
async function tryHandlePairing(
  deps: ExecutorCommandDeps,
  blob: string,
  cmdId: string,
): Promise<CommandResult | null> {
  const { companion } = deps;

  // `pair` is plaintext — peek it without a key.
  const peeked = peekPlaintext(blob);
  if (peeked?.type === 'pair') {
    const payload = isObj(peeked.payload) ? peeked.payload : {};
    const devicePubKeyHex = payload.devicePubKeyHex;
    if (typeof devicePubKeyHex !== 'string' || devicePubKeyHex.length === 0) {
      return { ok: false, error: 'bad_payload' };
    }
    try {
      const { executorPubKeyHex } = companion.beginPairing(devicePubKeyHex);
      // Reply UNSEALED — the executor pubkey is public and the channel isn't up
      // yet. The SAS is DISPLAYED in the executor UI, never transmitted.
      const plainReply = sealBlob(null, { executorPubKeyHex }, `${cmdId}:result`);
      return { ok: true, resultBlob: plainReply };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }

  // `pairConfirm` is SEALED with the pending device's session key. Opening it IS
  // the proof the phone holds the matching key (its SAS matched). Only attempt
  // when a pending device exists.
  const pendingPub = companion.pendingDevicePubKeyHex();
  if (pendingPub) {
    const pendingKey = companion.sessionKeyForDevice(pendingPub);
    if (pendingKey) {
      let opened: OpenedCommand | null = null;
      try {
        opened = openBlob(pendingKey, blob, `${cmdId}:cmd`);
      } catch {
        opened = null; // not a pairConfirm for this pending key — fall through.
      }
      if (opened?.type === 'pairConfirm') {
        try {
          companion.confirmPairing(pendingPub);
          // Reply SEALED with the now-paired session key (proves both directions).
          const sealed = sealBlob(pendingKey, { paired: true }, `${cmdId}:result`);
          return { ok: true, resultBlob: sealed, mutated: true };
        } catch (e) {
          return { ok: false, error: errMsg(e) };
        }
      }
    }
  }

  return null;
}

// Parse a blob as plaintext JSON without a key. Returns the OpenedCommand shape on
// success, or null when it isn't readable plaintext (i.e. it's ciphertext).
function peekPlaintext(blob: string): OpenedCommand | null {
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.type !== 'string') return null;
    return { type: obj.type, payload: obj.payload };
  } catch {
    return null;
  }
}

/** Dispatch a whitelist-validated command. Split out so pairing routing stays lean. */
async function dispatchCommand(
  deps: ExecutorCommandDeps,
  opened: OpenedCommand,
): Promise<CommandResult> {
  const { db, exchangeManager } = deps;
  const type = opened.type;
  if (!ALLOWED_SET.has(type)) {
    return { ok: false, error: 'unknown_command' };
  }

  const payload = isObj(opened.payload) ? opened.payload : {};

  try {
    switch (type as AllowedCommand) {
      // ── Safety: panic close-all (+ optional halt) ──
      case 'panic': {
        const halt = payload.halt === true;
        if (!exchangeManager) {
          // No venues to flatten — still honour the halt request so nothing opens.
          if (halt) db.setHaltState(true, 'remote');
          return { ok: true, result: { closed: 0, failed: 0, results: [], halted: halt } };
        }
        const report = await panicCloseAll(db, exchangeManager, { halt, reason: 'remote' });
        return { ok: true, result: report };
      }

      // ── Halt flag set/clear ──
      case 'setHalt': {
        if (typeof payload.halted !== 'boolean') return { ok: false, error: 'bad_payload' };
        const halted = payload.halted;
        const reason = halted ? (typeof payload.reason === 'string' ? payload.reason : 'remote') : null;
        db.setHaltState(halted, reason);
        return { ok: true, result: db.getHaltState() };
      }

      // ── Opt-in guardrails for (exchange, account) ──
      case 'setGuardrails': {
        const { exchange, account, maxDailyLoss, maxConcurrentPositions, maxTotalNotional } = payload;
        if (
          typeof exchange !== 'string' ||
          typeof account !== 'string' ||
          !nonNeg(maxDailyLoss) ||
          !nonNeg(maxConcurrentPositions) ||
          !Number.isInteger(maxConcurrentPositions) ||
          !nonNeg(maxTotalNotional)
        ) {
          return { ok: false, error: 'bad_payload' };
        }
        db.setGuardrails(exchange, account, { maxDailyLoss, maxConcurrentPositions, maxTotalNotional });
        return { ok: true, result: { exchange, account, maxDailyLoss, maxConcurrentPositions, maxTotalNotional } };
      }

      // ── Per-account sizing caps. Accepts one row or a batch. ──
      case 'setAccountSizes': {
        const rows = Array.isArray(payload.sizes)
          ? (payload.sizes as unknown[])
          : [payload];
        const applied: Array<{ exchange: string; account: string; root: string; maxContracts: number }> = [];
        for (const r of rows) {
          if (!isObj(r)) return { ok: false, error: 'bad_payload' };
          const { exchange, account, root, maxContracts } = r;
          if (
            typeof exchange !== 'string' ||
            typeof account !== 'string' ||
            typeof root !== 'string' ||
            !nonNeg(maxContracts)
          ) {
            return { ok: false, error: 'bad_payload' };
          }
          const normRoot = isFuturesRoot(root) ? root.toUpperCase() : sizingRoot(root);
          db.setAccountSize(exchange, account, normRoot, maxContracts);
          applied.push({ exchange, account, root: normRoot, maxContracts });
        }
        return { ok: true, result: { applied } };
      }

      // ── Bot lifecycle: start / stop / detach ──
      case 'botStart':
      case 'botStop': {
        const id = payload.id;
        if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'bad_payload' };
        if (!db.getBotConfig(id)) return { ok: false, error: 'not found' };
        db.setBotConfigStatus(id, type === 'botStart' ? 'running' : 'stopped');
        const updated = db.getBotConfig(id);
        return { ok: true, result: { id, status: updated?.status ?? (type === 'botStart' ? 'running' : 'stopped') } };
      }

      case 'botDetach': {
        const id = payload.id;
        if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'bad_payload' };
        try {
          return { ok: true, result: detachBot(db, id) };
        } catch (e) {
          if (e instanceof BotNotFoundError) return { ok: false, error: 'not found' };
          throw e;
        }
      }

      // ── Subscription pause / resume ──
      case 'subscriptionPause':
      case 'subscriptionResume': {
        const id = payload.id;
        if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'bad_payload' };
        if (!db.getSubscription(id)) return { ok: false, error: 'not found' };
        db.setSubscriptionStatus(id, type === 'subscriptionPause' ? 'paused' : 'active');
        return { ok: true, result: { id, status: type === 'subscriptionPause' ? 'paused' : 'active' } };
      }

      // ── Read-only state snapshot ──
      case 'getState': {
        if (!exchangeManager) {
          // Snapshot still works for the local-only state (halt/bots/subscriptions).
          const partial = await assembleExecutorState(db, null as unknown as ExchangeManager).catch(() => null);
          if (partial) return { ok: true, result: partial };
          return { ok: false, error: 'no_exchange_manager' };
        }
        const snapshot = await assembleExecutorState(db, exchangeManager);
        return { ok: true, result: snapshot };
      }

      default:
        return { ok: false, error: 'unknown_command' };
    }
  } catch (e) {
    db.log('error', 'system', 'Companion command failed', { type, error: errMsg(e) });
    return { ok: false, error: errMsg(e) };
  }
}
