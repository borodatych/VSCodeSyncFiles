import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "../../src/core/passkeyRecoveryCodes.js";
import {
  unwrapDekFromWebauthn,
  wrapDekForWebauthn,
  type DeriveKekFn,
} from "../../src/core/passkeyEnvelopeWrap.js";

describe("generateRecoveryCodes", () => {
  it("returns the requested number of codes + matching hashes", () => {
    const r = generateRecoveryCodes(7);
    expect(r.codes).toHaveLength(7);
    expect(r.hashes).toHaveLength(7);
    for (let i = 0; i < r.codes.length; i++) {
      expect(hashRecoveryCode(r.codes[i])).toBe(r.hashes[i]);
    }
  });

  it("formats codes as 5 groups of 4 chars from a-z 2-9 (no 0/o/1/i/l)", () => {
    const r = generateRecoveryCodes(3);
    for (const c of r.codes) {
      expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      expect(c).not.toMatch(/[01ilo]/);
    }
  });

  it("rejects out-of-range counts", () => {
    expect(() => generateRecoveryCodes(0)).toThrow();
    expect(() => generateRecoveryCodes(51)).toThrow();
  });
});

describe("hashRecoveryCode + verifyRecoveryCode", () => {
  it("normalises whitespace, dashes and case before hashing", () => {
    const h1 = hashRecoveryCode("AB CD-EFGH-IJKL-MNOP-QRST");
    const h2 = hashRecoveryCode("abcdefghijklmnopqrst");
    expect(h1).toBe(h2);
  });

  it("verifyRecoveryCode finds the index of a matching stored hash", () => {
    const r = generateRecoveryCodes(3);
    const idx = verifyRecoveryCode(r.codes[1], r.hashes);
    expect(idx).toBe(1);
  });

  it("verifyRecoveryCode returns null on no match", () => {
    const r = generateRecoveryCodes(3);
    const idx = verifyRecoveryCode("aaaa-bbbb-cccc-dddd-eeee", r.hashes);
    expect(idx).toBeNull();
  });

  it("verifyRecoveryCode skips consumed (empty-string) hashes", () => {
    const r = generateRecoveryCodes(2);
    const consumed = [...r.hashes];
    consumed[0] = ""; // mark as consumed
    expect(verifyRecoveryCode(r.codes[0], consumed)).toBeNull();
    expect(verifyRecoveryCode(r.codes[1], consumed)).toBe(1);
  });
});

describe("wrapDekForWebauthn + unwrapDekFromWebauthn (mock derive)", () => {
  // Mock derive: SHA-256(credentialId || salt) → 32 bytes. Deterministic so a
  // wrap/unwrap pair under the same credentialId+salt round-trips, but
  // observers can't recover the DEK without seeing the salt.
  const derive: DeriveKekFn = (credentialId, salt) => {
    return new Uint8Array(
      createHash("sha256").update(`${credentialId}|`).update(Buffer.from(salt)).digest(),
    );
  };

  const dek = new Uint8Array(randomBytes(32));

  it("round-trips DEK through wrap → unwrap with the same derive", () => {
    const env = wrapDekForWebauthn(dek, "cred-1", derive);
    const r = unwrapDekFromWebauthn(env, derive);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Buffer.from(r.rawDek).equals(Buffer.from(dek))).toBe(true);
    }
  });

  it("auth_failure when derive returns a different KEK", () => {
    const env = wrapDekForWebauthn(dek, "cred-1", derive);
    const otherDerive: DeriveKekFn = (id, salt) =>
      new Uint8Array(createHash("sha256").update(`OTHER|${id}|`).update(Buffer.from(salt)).digest());
    const r = unwrapDekFromWebauthn(env, otherDerive);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("auth_failure");
  });

  it("rejects DEK of wrong size", () => {
    expect(() => wrapDekForWebauthn(new Uint8Array(31), "cred", derive)).toThrow();
  });

  it("rejects shape when source is not webauthn", () => {
    const r = unwrapDekFromWebauthn(
      { v: 1, source: "none", ivB64: "", cipherB64: "" },
      derive,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("shape");
  });

  it("rejects shape when credentialId / salt missing from a webauthn envelope", () => {
    const r = unwrapDekFromWebauthn(
      { v: 1, source: "webauthn", ivB64: "", cipherB64: "" },
      derive,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("shape");
  });
});
