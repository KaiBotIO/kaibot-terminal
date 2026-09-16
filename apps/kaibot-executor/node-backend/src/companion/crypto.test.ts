// Companion E2E crypto core — the provability proof in tests.
import { describe, expect, it } from "bun:test";
import {
  generateIdentity,
  deriveSessionKey,
  computeSAS,
  seal,
  open,
  toHex,
  fromHex,
} from "./crypto";

describe("identity + session key", () => {
  it("two parties derive the SAME session key (X25519 DH)", () => {
    const exec = generateIdentity();
    const phone = generateIdentity();
    const kExec = deriveSessionKey(exec.secretKey, phone.publicKey);
    const kPhone = deriveSessionKey(phone.secretKey, exec.publicKey);
    expect(toHex(kExec)).toBe(toHex(kPhone));
    expect(kExec.length).toBe(32);
  });

  it("a different peer yields a different key", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    expect(toHex(deriveSessionKey(a.secretKey, b.publicKey))).not.toBe(
      toHex(deriveSessionKey(a.secretKey, c.publicKey)),
    );
  });
});

describe("seal / open round-trip (interop)", () => {
  it("executor seals, phone opens (and vice versa)", () => {
    const exec = generateIdentity();
    const phone = generateIdentity();
    const kExec = deriveSessionKey(exec.secretKey, phone.publicKey);
    const kPhone = deriveSessionKey(phone.secretKey, exec.publicKey);

    const cmd = JSON.stringify({ type: "panic", payload: { halt: true } });
    const blob = seal(kPhone, cmd, "cmd-1:cmd");
    expect(open(kExec, blob, "cmd-1:cmd")).toBe(cmd);

    const state = JSON.stringify({ halt: { halted: false } });
    const sblob = seal(kExec, state, "state");
    expect(open(kPhone, sblob, "state")).toBe(state);
  });

  it("the blob is opaque ciphertext, not readable plaintext", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const k = deriveSessionKey(a.secretKey, b.publicKey);
    const blob = seal(k, '{"type":"panic"}', "cmd-x:cmd");
    expect(blob).not.toContain("panic");
    expect(blob).not.toContain("type");
  });
});

describe("AEAD tamper + AAD binding", () => {
  it("a flipped ciphertext byte makes open throw", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const k = deriveSessionKey(a.secretKey, b.publicKey);
    const blob = seal(k, "secret", "aad-1");
    // Corrupt one char near the end (within the ciphertext/tag region).
    const i = blob.length - 4;
    const flipped = blob.slice(0, i) + (blob[i] === "A" ? "B" : "A") + blob.slice(i + 1);
    expect(() => open(k, flipped, "aad-1")).toThrow();
  });

  it("a mismatched AAD makes open throw (anti-reflection)", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const k = deriveSessionKey(a.secretKey, b.publicKey);
    const blob = seal(k, "secret", "cmd-1:cmd");
    expect(() => open(k, blob, "cmd-1:result")).toThrow();
  });

  it("the wrong key makes open throw", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const c = generateIdentity();
    const k = deriveSessionKey(a.secretKey, b.publicKey);
    const wrong = deriveSessionKey(a.secretKey, c.publicKey);
    const blob = seal(k, "secret", "aad");
    expect(() => open(wrong, blob, "aad")).toThrow();
  });
});

describe("SAS — code-authenticated pairing (no server MITM)", () => {
  it("is deterministic and order-independent", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const s1 = computeSAS(a.publicKey, b.publicKey);
    const s2 = computeSAS(b.publicKey, a.publicKey);
    expect(s1).toBe(s2);
    expect(s1).toHaveLength(8);
  });

  it("MITM: a swapped key makes the two sides compute DIFFERENT codes", () => {
    const exec = generateIdentity();
    const phone = generateIdentity();
    const attacker = generateIdentity();
    // Honest pairing: both sides see the real peer key → same SAS.
    expect(computeSAS(phone.publicKey, exec.publicKey)).toBe(
      computeSAS(exec.publicKey, phone.publicKey),
    );
    // Relay MITM: phone is shown attacker's key as "executor"; executor is shown
    // attacker's key as "phone". The code the phone computes ≠ the code the
    // executor displays → the typed code won't match → pairing rejected.
    const phoneSeesCode = computeSAS(phone.publicKey, attacker.publicKey);
    const execDisplaysCode = computeSAS(attacker.publicKey, exec.publicKey);
    expect(phoneSeesCode).not.toBe(execDisplaysCode);
  });
});

describe("hex helpers", () => {
  it("round-trips", () => {
    const id = generateIdentity();
    expect(toHex(fromHex(toHex(id.publicKey)))).toBe(toHex(id.publicKey));
  });
});
