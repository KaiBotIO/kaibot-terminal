import { describe, expect, it } from 'bun:test';
import { open, seal } from './seal.js';
import { generateIdentity, deriveSessionKey } from './crypto.js';

// The seal seam is now state-driven (Layer 3). With a session key every frame is
// AEAD-sealed; with a null key (the pairing window) the blob is plaintext JSON.
// These tests pin the CONTRACT callers rely on.

function session() {
  const a = generateIdentity();
  const b = generateIdentity();
  return deriveSessionKey(a.secretKey, b.publicKey);
}

describe('seal seam — sealed path (session key present)', () => {
  it('round-trips a command through seal → open', () => {
    const key = session();
    const cmd = { type: 'setHalt', payload: { halted: true, reason: 'remote' } };
    const blob = seal(key, cmd, 'cmd-1:cmd');
    expect(typeof blob).toBe('string');
    const opened = open(key, blob, 'cmd-1:cmd');
    expect(opened.type).toBe('setHalt');
    expect(opened.payload).toEqual({ halted: true, reason: 'remote' });
  });

  it('the sealed blob is CIPHERTEXT — no readable JSON', () => {
    const key = session();
    const blob = seal(key, { type: 'panic', payload: { halt: true } }, 'cmd-1:cmd');
    expect(blob).not.toContain('panic');
    expect(blob).not.toContain('type');
    expect(() => JSON.parse(blob)).toThrow();
  });

  it('open throws on a tampered blob (AEAD tag check)', () => {
    const key = session();
    const blob = seal(key, { type: 'setHalt', payload: {} }, 'cmd-1:cmd');
    const i = blob.length - 4;
    const flipped = blob.slice(0, i) + (blob[i] === 'A' ? 'B' : 'A') + blob.slice(i + 1);
    expect(() => open(key, flipped, 'cmd-1:cmd')).toThrow();
  });

  it('open throws on an AAD mismatch (anti-reflection)', () => {
    const key = session();
    const blob = seal(key, { type: 'setHalt', payload: {} }, 'cmd-1:cmd');
    expect(() => open(key, blob, 'cmd-1:result')).toThrow();
  });
});

describe('seal seam — pairing window (null session key = plaintext)', () => {
  it('round-trips a pair message as plaintext JSON', () => {
    const cmd = { type: 'pair', payload: { devicePubKeyHex: 'ab12' } };
    const blob = seal(null, cmd, 'cmd-1:cmd');
    // Plaintext — readable on the wire (pubkeys are public; pairing predates the
    // sealed channel).
    expect(blob).toContain('pair');
    const opened = open(null, blob, 'cmd-1:cmd');
    expect(opened.type).toBe('pair');
    expect(opened.payload).toEqual({ devicePubKeyHex: 'ab12' });
  });

  it('open throws when the plaintext type field is missing', () => {
    expect(() => open(null, JSON.stringify({ payload: {} }), 'aad')).toThrow();
  });

  it('open throws on malformed plaintext JSON', () => {
    expect(() => open(null, '{not json', 'aad')).toThrow();
  });
});
