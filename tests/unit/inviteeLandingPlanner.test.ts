import { describe, expect, it } from "vitest";
import { planInviteeLanding } from "../../src/core/inviteeLandingPlanner.js";
import type { SnapshotShareACL } from "../../src/core/cloudLayout.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const PWD_OK_HEX = "f".repeat(64);
const PWD_BAD_HEX = "0".repeat(64);

function aclOk(overrides: Partial<SnapshotShareACL> = {}): SnapshotShareACL {
  return {
    hashedPwdHex: PWD_OK_HEX,
    expiresAtIso: new Date(NOW + 24 * HOUR).toISOString(),
    readOnly: true,
    ...overrides,
  };
}

describe("planInviteeLanding — workspace presence", () => {
  it("rejects with reject_unknown_workspace when the workspace is not mounted locally", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: false,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("reject_unknown_workspace");
  });
});

describe("planInviteeLanding — expiry", () => {
  it("rejects with reject_expired when ACL is missing (cloudAcl=null)", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: null,
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("reject_expired");
  });

  it("rejects with reject_expired when the URL exp param is in the past", () => {
    const r = planInviteeLanding({
      parsed: {
        workspaceId: "ws-a",
        snapshotName: "snap-1",
        expiresAtMs: NOW - HOUR,
      },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("reject_expired");
  });

  it("rejects with reject_expired when ACL TTL elapsed", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk({ expiresAtIso: new Date(NOW - HOUR).toISOString() }),
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("reject_expired");
  });
});

describe("planInviteeLanding — password prompt flow", () => {
  it("returns show_password_prompt when no password has been entered yet", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
    });
    expect(r.kind).toBe("show_password_prompt");
  });

  it("returns show_password_prompt when supplied password is empty string", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: "",
    });
    expect(r.kind).toBe("show_password_prompt");
  });
});

describe("planInviteeLanding — password verification", () => {
  it("returns mount_readonly when password hash matches", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("mount_readonly");
    if (r.kind === "mount_readonly") {
      expect(r.workspaceId).toBe("ws-a");
      expect(r.snapshotName).toBe("snap-1");
    }
  });

  it("returns reject_bad_password with remaining attempts on hash mismatch", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_BAD_HEX,
      recentFailedAttempts: 1,
    });
    expect(r.kind).toBe("reject_bad_password");
    if (r.kind === "reject_bad_password") {
      // 5 default - 1 already used - 1 just used = 3 remaining
      expect(r.attemptsRemaining).toBe(3);
    }
  });

  it("returns reject_bad_password with zero remaining when caller is at max", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_BAD_HEX,
      recentFailedAttempts: 4,
    });
    expect(r.kind).toBe("reject_bad_password");
    if (r.kind === "reject_bad_password") {
      expect(r.attemptsRemaining).toBe(0);
    }
  });

  it("respects a caller-supplied maxAttempts override", () => {
    const r = planInviteeLanding({
      parsed: { workspaceId: "ws-a", snapshotName: "snap-1" },
      nowMs: NOW,
      hasMatchingWorkspace: true,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_BAD_HEX,
      recentFailedAttempts: 0,
      maxAttempts: 2,
    });
    expect(r.kind).toBe("reject_bad_password");
    if (r.kind === "reject_bad_password") {
      expect(r.attemptsRemaining).toBe(1);
    }
  });
});

describe("planInviteeLanding — guard ordering", () => {
  it("checks workspace presence before TTL (so unknown workspace beats expiry message)", () => {
    const r = planInviteeLanding({
      parsed: {
        workspaceId: "ws-a",
        snapshotName: "snap-1",
        expiresAtMs: NOW - HOUR,
      },
      nowMs: NOW,
      hasMatchingWorkspace: false,
      cloudAcl: aclOk(),
      suppliedPwdHashHex: PWD_OK_HEX,
    });
    expect(r.kind).toBe("reject_unknown_workspace");
  });
});
