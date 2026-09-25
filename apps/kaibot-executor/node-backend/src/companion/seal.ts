// Seal seam for the remote-companion control plane (Layer 3 — real AEAD).
//
// The central API relays an OPAQUE `blob` between the phone and this executor —
// it never reads command/state content. This file is the ONE seam every command
// handler / state pusher goes through; the callers pass the paired device's
// session key + an `aad` (context binding) and stay otherwise unchanged.
//
// State-driven plaintext window for PAIRING ONLY: pairing messages (`pair` /
// `pairConfirm`) predate the sealed channel, so `pair` rides `blob` as PLAINTEXT
// JSON (pubkeys are public). When the session key is null we treat the blob as
// that plaintext; once a session key exists, every frame is XChaCha20-Poly1305
// sealed. AAD binds `${cmdId}:cmd` / `${cmdId}:result` / `state` (anti-reflection).
//
// Invariant for callers: a sealed blob is always a STRING; the cleartext object
// is `{ type, payload }` for commands and an arbitrary record for state/result.

import { seal as cryptoSeal, open as cryptoOpen } from './crypto.js';

export interface OpenedCommand {
  type: string;
  payload?: unknown;
}

function asOpenedCommand(parsed: unknown): OpenedCommand {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('sealed blob is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    throw new Error('sealed blob has no string `type`');
  }
  return { type: obj.type, payload: obj.payload };
}

// Open an inbound blob into its cleartext command. `sessionKey === null` ⇒ the
// device is mid-pairing (no key yet) and the blob is PLAINTEXT pair JSON; else
// AEAD-open with the session key + aad (throws on tamper/wrong-key/wrong-aad,
// which the handler maps to `bad_payload`).
export function open(
  sessionKey: Uint8Array | null,
  blob: string,
  aad: string,
): OpenedCommand {
  const json = sessionKey ? cryptoOpen(sessionKey, blob, aad) : blob;
  return asOpenedCommand(JSON.parse(json) as unknown);
}

// Seal a cleartext result/state object into a blob. `sessionKey === null` ⇒
// plaintext JSON (pairing replies only — pubkeys are public); else AEAD-sealed.
export function seal(sessionKey: Uint8Array | null, obj: unknown, aad: string): string {
  const json = JSON.stringify(obj);
  return sessionKey ? cryptoSeal(sessionKey, json, aad) : json;
}
