import { describe, expect, it } from "vitest";
import { verifySnapshotShareACL } from "../../src/core/shareLink.js";
import type { SnapshotShareACL } from "../../src/core/cloudLayout.js";

const NOW = 1_700_000_000_000;
const PWD_HASH = "a".repeat(64);

const acl = (over: Partial<SnapshotShareACL> = {}): SnapshotShareACL => ({
  hashedPwdHex: PWD_HASH,
  expiresAtIso: new Date(NOW + 60_000).toISOString(),
  readOnly: true,
  ...over,
});

describe("verifySnapshotShareACL", () => {
  it("ok when ACL has matching pwd hash and is fresh", () => {
    const r = verifySnapshotShareACL(acl(), PWD_HASH, NOW);
    expect(r.ok).toBe(true);
  });

  it("missing_acl when ACL undefined", () => {
    const r = verifySnapshotShareACL(undefined, PWD_HASH, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_acl");
  });

  it("expired when now > expiresAtIso", () => {
    const r = verifySnapshotShareACL(
      acl({ expiresAtIso: new Date(NOW - 1).toISOString() }),
      PWD_HASH,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("wrong_password when pwd hash mismatches", () => {
    const r = verifySnapshotShareACL(acl(), "b".repeat(64), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_password");
  });

  it("wrong_password when pwd hash undefined", () => {
    const r = verifySnapshotShareACL(acl(), undefined, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_password");
  });

  it("wrong_password when length mismatches (cheap pre-check)", () => {
    const r = verifySnapshotShareACL(acl(), "short", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_password");
  });

  it("expired when expiresAtIso is unparseable", () => {
    const r = verifySnapshotShareACL(
      acl({ expiresAtIso: "not-an-iso" }),
      PWD_HASH,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });
});
