import { describe, expect, it } from "vitest";
import {
  decodeGraphRenewExpiration,
  decodeGraphSubscriptionEnvelope,
} from "../../src/core/graphSubscriptionResponseDecoder.js";

describe("decodeGraphSubscriptionEnvelope — happy path", () => {
  it("decodes a typical create-subscription response", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "sub-1234",
      expirationDateTime: "2026-05-08T12:00:00Z",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.value.id).toBe("sub-1234");
    expect(r.value.expirationDateTime).toBe("2026-05-08T12:00:00Z");
  });

  it("accepts ISO with milliseconds and timezone offset", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "sub-x",
      expirationDateTime: "2026-05-08T12:00:00.123+02:00",
    });
    expect(r.ok).toBe(true);
  });

  it("ignores extra fields (forward-compat)", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "sub-1",
      expirationDateTime: "2026-05-08T12:00:00Z",
      changeType: "updated",
      resource: "/me/drive/root",
      future: { whatever: 42 },
    });
    expect(r.ok).toBe(true);
  });
});

describe("decodeGraphSubscriptionEnvelope — rejection paths", () => {
  it("rejects non-object inputs", () => {
    for (const x of [null, undefined, 42, "string", true, [], [{}]]) {
      const r = decodeGraphSubscriptionEnvelope(x);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error();
      expect(r.reason).toBe("not_object");
    }
  });

  it("rejects missing id", () => {
    const r = decodeGraphSubscriptionEnvelope({ expirationDateTime: "2026-05-08T12:00:00Z" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("missing_id");
  });

  it("rejects bad id type", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: 123,
      expirationDateTime: "2026-05-08T12:00:00Z",
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_id_type");
  });

  it("rejects empty id string", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "",
      expirationDateTime: "2026-05-08T12:00:00Z",
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_id_type");
  });

  it("rejects missing expirationDateTime", () => {
    const r = decodeGraphSubscriptionEnvelope({ id: "sub-1" });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("missing_expiration");
  });

  it("rejects non-string expiration", () => {
    const r = decodeGraphSubscriptionEnvelope({ id: "sub-1", expirationDateTime: 1234567 });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_type");
  });

  it("rejects malformed ISO date string", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "sub-1",
      expirationDateTime: "not-a-date",
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_format");
  });

  it("rejects ISO-shaped but invalid date (e.g. month 13)", () => {
    const r = decodeGraphSubscriptionEnvelope({
      id: "sub-1",
      expirationDateTime: "2026-13-40T12:00:00Z",
    });
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_format");
  });
});

describe("decodeGraphRenewExpiration", () => {
  it("returns the new expiration when present and valid", () => {
    const r = decodeGraphRenewExpiration(
      { expirationDateTime: "2026-05-09T08:00:00Z" },
      "2026-05-08T08:00:00Z",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.expirationDateTime).toBe("2026-05-09T08:00:00Z");
  });

  it("falls back to caller-supplied expiration when missing", () => {
    const r = decodeGraphRenewExpiration({}, "2026-05-08T08:00:00Z");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.expirationDateTime).toBe("2026-05-08T08:00:00Z");
  });

  it("falls back when the field is explicitly undefined", () => {
    const r = decodeGraphRenewExpiration(
      { expirationDateTime: undefined },
      "2026-05-08T08:00:00Z",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects array root", () => {
    const r = decodeGraphRenewExpiration([], "fallback");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("not_object");
  });

  it("rejects bad expiration type", () => {
    const r = decodeGraphRenewExpiration({ expirationDateTime: 1000 }, "fallback");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_type");
  });

  it("rejects malformed ISO", () => {
    const r = decodeGraphRenewExpiration(
      { expirationDateTime: "yesterday" },
      "fallback",
    );
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad_expiration_format");
  });
});
