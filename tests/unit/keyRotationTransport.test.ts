import { describe, expect, it } from "vitest";
import {
  buildKeyRotationTransport,
  cloudPathForKeyRotation,
  decodeKeyRotationTransport,
} from "../../src/core/keyRotationTransport.js";

const NOW = 1_700_000_000_000;
const RID = "rotation-12345";
const KID_OLD = "AAAA1111BBBB2222CCCC3333";
const KID_NEW = "DDDD4444EEEE5555FFFF6666";

describe("cloudPathForKeyRotation", () => {
  it("renders _keyrotation/{rotationId}.json", () => {
    expect(cloudPathForKeyRotation(RID)).toBe(`_keyrotation/${RID}.json`);
  });

  it("rejects path-traversal in rotationId", () => {
    expect(() => cloudPathForKeyRotation("../escape")).toThrow(/invalid rotationId/);
  });
});

describe("buildKeyRotationTransport + decodeKeyRotationTransport", () => {
  it("round-trips a valid envelope", () => {
    const env = buildKeyRotationTransport({
      rotationId: RID,
      fromKeyId: KID_OLD,
      toKeyId: KID_NEW,
      encryptedBlobB64: "AAAA",
      ivB64: "BBBB",
      authTagB64: "CCCC",
      createdAtMs: NOW,
    });
    const r = decodeKeyRotationTransport(JSON.stringify(env), { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope.rotationId).toBe(RID);
      expect(r.envelope.fromKeyId).toBe(KID_OLD);
    }
  });

  it("decodes from Buffer payload", () => {
    const env = buildKeyRotationTransport({
      rotationId: RID,
      fromKeyId: KID_OLD,
      toKeyId: KID_NEW,
      encryptedBlobB64: "x",
      ivB64: "y",
      authTagB64: "z",
      createdAtMs: NOW,
    });
    const r = decodeKeyRotationTransport(Buffer.from(JSON.stringify(env), "utf8"), { now: NOW });
    expect(r.ok).toBe(true);
  });

  it("rejects bad JSON", () => {
    const r = decodeKeyRotationTransport("{not-json", { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_json");
  });

  it("rejects mismatched version", () => {
    const r = decodeKeyRotationTransport(
      JSON.stringify({ v: 99, rotationId: RID, fromKeyId: KID_OLD, toKeyId: KID_NEW, createdAt: new Date(NOW).toISOString(), encryptedBlobB64: "x", ivB64: "y", authTagB64: "z" }),
      { now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_shape");
  });

  it("rejects bad rotationId", () => {
    const r = decodeKeyRotationTransport(
      JSON.stringify({
        v: 1,
        rotationId: "../bad",
        fromKeyId: KID_OLD,
        toKeyId: KID_NEW,
        createdAt: new Date(NOW).toISOString(),
        encryptedBlobB64: "x",
        ivB64: "y",
        authTagB64: "z",
      }),
      { now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_rotation_id");
  });

  it("rejects stale envelopes past staleAfterMs", () => {
    const env = buildKeyRotationTransport({
      rotationId: RID,
      fromKeyId: KID_OLD,
      toKeyId: KID_NEW,
      encryptedBlobB64: "x",
      ivB64: "y",
      authTagB64: "z",
      createdAtMs: NOW,
    });
    const r = decodeKeyRotationTransport(JSON.stringify(env), {
      now: NOW + 31 * 24 * 60 * 60_000, // 31 days later
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("stale");
  });

  it("rejects invalid keyId format", () => {
    expect(() =>
      buildKeyRotationTransport({
        rotationId: RID,
        fromKeyId: "short",
        toKeyId: KID_NEW,
        encryptedBlobB64: "x",
        ivB64: "y",
        authTagB64: "z",
      }),
    ).toThrow(/invalid keyId/);
  });
});
