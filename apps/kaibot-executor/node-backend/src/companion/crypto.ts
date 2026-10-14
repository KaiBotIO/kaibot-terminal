// Companion E2E crypto core — the SINGLE source of truth, byte-identical on both
// the executor (Bun) and the phone (React Native). Pure @noble (audited, no native
// modules). The relay server never holds a private key and never sees plaintext.
//
// Scheme (see docs/companion-e2e.md):
//   identity: long-term X25519 keypair (private key stays on-device)
//   pairing : SAS = base32(sha256(sorted(pkA,pkB))[:5]) — code-authenticated, no MITM
//   session : key = hkdf(sha256, x25519(mySk, peerPk), "", "kaibot-companion-v1")
//   seal    : blob = base64(nonce24 ‖ xchacha20poly1305(key,nonce,aad).encrypt(pt))
//
// Keep portable: NO Node Buffer / btoa — RN Hermes lacks them. Needs
// crypto.getRandomValues (Bun native; RN via react-native-get-random-values).
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const KDF_INFO = enc.encode("kaibot-companion-v1");

export interface IdentityKeyPair {
  secretKey: Uint8Array; // 32 bytes — NEVER leaves the device
  publicKey: Uint8Array; // 32 bytes — safe to share via the relay
}

export function generateIdentity(): IdentityKeyPair {
  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

// Shared symmetric key from my private + the peer's public identity key.
export function deriveSessionKey(
  mySecretKey: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array {
  const shared = x25519.getSharedSecret(mySecretKey, peerPublicKey);
  return hkdf(sha256, shared, new Uint8Array(0), KDF_INFO, 32);
}

// Short Authentication String: an 8-char Crockford-base32 code (40 bits),
// deterministic and order-independent over both public keys. Displayed on the
// executor; the phone computes the same value and the user types the executor's
// code to confirm no relay MITM swapped a key.
export function computeSAS(pkA: Uint8Array, pkB: Uint8Array): string {
  const [lo, hi] = compareBytes(pkA, pkB) <= 0 ? [pkA, pkB] : [pkB, pkA];
  const digest = sha256(concatBytes(lo, hi));
  return base32Crockford(digest.slice(0, 5));
}

// Seal a UTF-8 plaintext. `aad` binds context (e.g. `${cmdId}:cmd`) so a frame
// can't be reflected/replayed in another slot. Output is base64(nonce ‖ ct+tag).
export function seal(sessionKey: Uint8Array, plaintext: string, aad: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  const ct = xchacha20poly1305(sessionKey, nonce, enc.encode(aad)).encrypt(
    enc.encode(plaintext),
  );
  return bytesToBase64(concatBytes(nonce, ct));
}

// Open a sealed blob. Throws if the key/aad is wrong or the ciphertext was
// tampered (AEAD tag check) — callers treat a throw as a rejected frame.
export function open(sessionKey: Uint8Array, blob: string, aad: string): string {
  const raw = base64ToBytes(blob);
  if (raw.length < 24 + 16) throw new Error("companion: blob too short");
  const nonce = raw.slice(0, 24);
  const ct = raw.slice(24);
  const pt = xchacha20poly1305(sessionKey, nonce, enc.encode(aad)).decrypt(ct);
  return dec.decode(pt);
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// --- portable byte helpers (no Buffer/btoa) ---
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    s += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : "=";
    s += i + 2 < bytes.length ? B64[b2 & 63] : "=";
  }
  return s;
}
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0, acc = 0, oi = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, oi);
}
// Crockford base32 (no I/L/O/U) — friendlier to read/type than RFC4648.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function base32Crockford(bytes: Uint8Array): string {
  let bits = 0, acc = 0, s = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      s += B32[(acc >> bits) & 31];
    }
  }
  if (bits > 0) s += B32[(acc << (5 - bits)) & 31];
  return s;
}
