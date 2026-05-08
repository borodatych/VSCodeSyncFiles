import { describe, expect, it } from "vitest";
import {
  decodeGdrivePushChannelEnvelope,
  gdriveExpirationToIso,
} from "../../src/core/gdrivePushChannelResponseDecoder.js";

const FUTURE_MS = "1893456000000"; // 2030-01-01T00:00:00Z

describe("decodeGdrivePushChannelEnvelope — happy", () => {
  it("decodes a valid watch response", () => {
    const r = decodeGdrivePushChannelEnvelope({
      id: "ch-1",
      resourceId: "res-1",
      expiration: FUTURE_MS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.id).toBe("ch-1");
    expect(r.value.resourceId).toBe("res-1");
    expect(r.value.expiration).toBe(FUTURE_MS);
    expect(r.value.expirationMs).toBe(Number(FUTURE_MS));
  });

  it("ignores extra fields (forward-compat)", () => {
    const r = decodeGdrivePushChannelEnvelope({
      id: "ch-1",
      resourceId: "res-1",
      expiration: FUTURE_MS,
      type: "web_hook",
      kind: "api#channel",
    });
    expect(r.ok).toBe(true);
  });
});

describe("decodeGdrivePushChannelEnvelope — rejection", () => {
  it("rejects non-object inputs", () => {
    for (const x of [null, undefined, 42, "string", true, []]) {
      const r = decodeGdrivePushChannelEnvelope(x);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error();
      expect(r.reason).toBe("not_object");
    }
  });

  it("rejects missing id", () => {
    const r = decodeGdrivePushChannelEnvelope({ resourceId: "r", expiration: FUTURE_MS });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("missing_id");
  });

  it("rejects bad id type", () => {
    const r = decodeGdrivePushChannelEnvelope({ id: 123, resourceId: "r", expiration: FUTURE_MS });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_id_type");
  });

  it("rejects empty id", () => {
    const r = decodeGdrivePushChannelEnvelope({ id: "", resourceId: "r", expiration: FUTURE_MS });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_id_type");
  });

  it("rejects missing resourceId", () => {
    const r = decodeGdrivePushChannelEnvelope({ id: "x", expiration: FUTURE_MS });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("missing_resource_id");
  });

  it("rejects bad resourceId type", () => {
    const r = decodeGdrivePushChannelEnvelope({
      id: "x",
      resourceId: 0,
      expiration: FUTURE_MS,
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_resource_id_type");
  });

  it("rejects missing expiration", () => {
    const r = decodeGdrivePushChannelEnvelope({ id: "x", resourceId: "r" });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("missing_expiration");
  });

  it("rejects non-string expiration", () => {
    const r = decodeGdrivePushChannelEnvelope({
      id: "x",
      resourceId: "r",
      expiration: 1893456000000,
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_type");
  });

  it("rejects non-numeric expiration string", () => {
    const r = decodeGdrivePushChannelEnvelope({
      id: "x",
      resourceId: "r",
      expiration: "tomorrow",
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_format");
  });

  it("rejects negative / zero / leading-zero expiration", () => {
    for (const exp of ["0", "-1", "012345"]) {
      const r = decodeGdrivePushChannelEnvelope({ id: "x", resourceId: "r", expiration: exp });
      if (r.ok) throw new Error();
      expect(r.reason).toBe("bad_expiration_format");
    }
  });
});

describe("gdriveExpirationToIso", () => {
  it("converts an epoch-ms string to ISO-8601", () => {
    const r = gdriveExpirationToIso(FUTURE_MS);
    expect(r).toBe("2030-01-01T00:00:00.000Z");
  });

  it("returns null on malformed input", () => {
    expect(gdriveExpirationToIso("0")).toBeNull();
    expect(gdriveExpirationToIso("abc")).toBeNull();
    expect(gdriveExpirationToIso("")).toBeNull();
    expect(gdriveExpirationToIso("-100")).toBeNull();
  });
});
