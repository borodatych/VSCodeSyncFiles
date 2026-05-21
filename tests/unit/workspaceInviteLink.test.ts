import { describe, expect, it } from "vitest";
import {
  decodeInviteLink,
  encodeInviteLink,
} from "../../src/core/workspaceInviteLink.js";

describe("encodeInviteLink + decodeInviteLink", () => {
  it("round-trips basic invite", () => {
    const link = encodeInviteLink({
      workspaceId: "abcd1234",
      workspaceNote: "My Project",
      providerType: "onedrive",
      ttlHours: 24,
      nowIso: "2026-05-21T00:00:00.000Z",
    });
    expect(link.startsWith("vscodesync://invite/")).toBe(true);
    const r = decodeInviteLink(link, "2026-05-21T01:00:00.000Z");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.invite.workspaceId).toBe("abcd1234");
      expect(r.invite.workspaceNote).toBe("My Project");
      expect(r.invite.providerType).toBe("onedrive");
      expect(r.invite.expiresAtIso).toBeDefined();
    }
  });

  it("ttlHours=0 → no exp field", () => {
    const link = encodeInviteLink({
      workspaceId: "x",
      workspaceNote: "y",
      providerType: "gdrive",
      ttlHours: 0,
      nowIso: "2026-05-21T00:00:00.000Z",
    });
    const r = decodeInviteLink(link);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invite.expiresAtIso).toBeUndefined();
  });

  it("rejects scheme mismatch", () => {
    const r = decodeInviteLink("https://example.com/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("scheme_mismatch");
  });

  it("rejects different host", () => {
    const r = decodeInviteLink("vscodesync://workspace/abcd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("host_mismatch");
  });

  it("rejects expired invite", () => {
    const link = encodeInviteLink({
      workspaceId: "x",
      workspaceNote: "y",
      providerType: "onedrive",
      ttlHours: 1,
      nowIso: "2026-05-21T00:00:00.000Z",
    });
    const r = decodeInviteLink(link, "2026-05-21T02:00:00.000Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expired");
  });

  it("rejects invite issued far in the future (clock skew abuse)", () => {
    const link = encodeInviteLink({
      workspaceId: "x",
      workspaceNote: "y",
      providerType: "onedrive",
      nowIso: "2026-05-21T00:00:00.000Z",
    });
    const r = decodeInviteLink(link, "2026-05-20T00:00:00.000Z");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("issued_in_future");
  });

  it("rejects malformed base64", () => {
    const r = decodeInviteLink("vscodesync://invite/!@#$%");
    expect(r.ok).toBe(false);
  });

  it("passphraseFingerprint is preserved", () => {
    const link = encodeInviteLink({
      workspaceId: "x",
      workspaceNote: "y",
      providerType: "onedrive",
      passphraseFingerprint: "abc123def456",
      ttlHours: 0,
      nowIso: "2026-05-21T00:00:00.000Z",
    });
    const r = decodeInviteLink(link);
    if (r.ok) {
      expect(r.invite.passphraseFingerprint).toBe("abc123def456");
    }
  });
});
