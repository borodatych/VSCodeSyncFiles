/**
 * Smoke tests for Phase 24 skeleton helpers.
 * Each helper gets the minimum scenarios needed to lock the surface;
 * the full wiring tests come when the UI / engine integration ships.
 */
import { describe, expect, it } from "vitest";

import {
  planRemotePresenceChips,
  RemotePresenceNotReadyError,
} from "../../src/core/remotePresencePlanner.js";
import {
  planSyncRewind,
  SyncRewindNotImplementedError,
} from "../../src/core/syncRewindPlanner.js";
import { UndoableActionRegistry } from "../../src/core/undoableActionRegistry.js";
import {
  findChunkBoundaries,
  CdcStoreNotConnectedError,
} from "../../src/core/contentDefinedChunking.js";
import {
  decidePassphraseAllowance,
  PassphraseDeniedByPasskeyOnlyError,
} from "../../src/core/passkeyOnlyMode.js";
import {
  buildSnapshotTag,
  isSnapshotTag,
  DEFAULT_GH_SNAPSHOT_TAG_PREFIX,
  GhReleasesProviderNotImplementedError,
} from "../../src/core/githubReleasesProviderPlanner.js";
import {
  isValidBucketName,
  s3ObjectKeyForCloudPath,
  S3ProviderNotImplementedError,
} from "../../src/core/s3ProviderPlanner.js";
import {
  decodeTrustInvite,
  encodeTrustInvite,
  signTrustInvite,
  type TrustInvitePayload,
} from "../../src/core/trustedTeammatesInvitePlanner.js";

describe("F2 remotePresencePlanner", () => {
  it("filters out the local machine and caps chips per file", () => {
    const chips = planRemotePresenceChips(
      {
        localMachineId: "me",
        maxChipsPerFile: 2,
        locks: [
          { workspaceId: "w1", posixRel: "a.ts", editingBy: "me" },
          { workspaceId: "w1", posixRel: "a.ts", editingBy: "alice", editingByName: "Alice" },
          { workspaceId: "w1", posixRel: "a.ts", editingBy: "bob", editingByName: "Bob" },
          { workspaceId: "w1", posixRel: "a.ts", editingBy: "carol", editingByName: "Carol" },
        ],
      },
      Date.now(),
    );
    expect(chips).toHaveLength(2);
    expect(chips.every((c) => c.machineId !== "me")).toBe(true);
  });
  it("sentinel is throwable and named", () => {
    expect(() => {
      throw new RemotePresenceNotReadyError("no signaling");
    }).toThrow(/no signaling/);
  });
});

describe("F6 syncRewindPlanner", () => {
  const row = (v: number, iso: string): { cloudPath: string; version: number; writtenAtIso: string; hash: string } => ({
    cloudPath: `.history/x/v${String(v)}-${iso}`,
    version: v,
    writtenAtIso: iso,
    hash: `h${String(v)}`,
  });
  it("no history → no_history", () => {
    expect(planSyncRewind({ rows: [], targetMs: Date.now() }).kind).toBe("no_history");
  });
  it("target before earliest", () => {
    const r = planSyncRewind({
      rows: [row(1, "2026-05-01T10:00:00Z"), row(2, "2026-05-02T10:00:00Z")],
      targetMs: Date.parse("2026-04-01T00:00:00Z"),
    });
    expect(r.kind).toBe("target_too_old");
  });
  it("target after latest → latest", () => {
    const r = planSyncRewind({
      rows: [row(1, "2026-05-01T10:00:00Z"), row(2, "2026-05-02T10:00:00Z")],
      targetMs: Date.parse("2026-05-10T00:00:00Z"),
    });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.row.version).toBe(2);
  });
  it("target between → latest ≤ target", () => {
    const r = planSyncRewind({
      rows: [
        row(1, "2026-05-01T10:00:00Z"),
        row(2, "2026-05-02T10:00:00Z"),
        row(3, "2026-05-03T10:00:00Z"),
      ],
      targetMs: Date.parse("2026-05-02T15:00:00Z"),
    });
    expect(r.kind).toBe("match");
    if (r.kind === "match") expect(r.row.version).toBe(2);
  });
  it("sentinel", () => {
    expect(() => {
      throw new SyncRewindNotImplementedError();
    }).toThrow(/not implemented/);
  });
});

describe("U3 UndoableActionRegistry", () => {
  it("registers, snapshots, expires, consumes", () => {
    const r = new UndoableActionRegistry(3);
    const a = r.register({
      undoTag: "delete_workspace_cloud",
      summary: "Delete X",
      payload: { x: 1 },
      ttlMs: 50,
    });
    expect(r.snapshot().active).toContain(a);
    const future = Date.now() + 200;
    expect(r.snapshot(future).expired).toContain(a);
    expect(r.consume(a)).toBe(true);
    expect(r.consume(a)).toBe(false);
  });
  it("ring drops the oldest beyond capacity", () => {
    const r = new UndoableActionRegistry(2);
    r.register({ undoTag: "force_detach", summary: "1", payload: {} });
    r.register({ undoTag: "force_detach", summary: "2", payload: {} });
    r.register({ undoTag: "force_detach", summary: "3", payload: {} });
    const summaries = r.snapshot().active.map((e) => e.summary);
    expect(summaries).toEqual(["3", "2"]);
  });
});

describe("M1 contentDefinedChunking", () => {
  it("empty buffer → no boundaries", () => {
    expect(findChunkBoundaries(Buffer.alloc(0))).toEqual([]);
  });
  it("short buffer → single chunk ends at length", () => {
    const buf = Buffer.alloc(1024, 0x41);
    expect(findChunkBoundaries(buf)).toEqual([1024]);
  });
  it("large buffer always covers the full length", () => {
    const buf = Buffer.alloc(200_000);
    for (let i = 0; i < buf.length; i += 1) buf[i] = i & 0xff;
    const ends = findChunkBoundaries(buf);
    expect(ends[ends.length - 1]).toBe(buf.length);
  });
  it("sentinel", () => {
    expect(() => {
      throw new CdcStoreNotConnectedError();
    }).toThrow();
  });
});

describe("M4 passkeyOnlyMode", () => {
  it("off → allow", () => {
    expect(
      decidePassphraseAllowance({ passkeyOnly: false, hasRegisteredPasskey: true }).kind,
    ).toBe("allow_passphrase");
  });
  it("on but no passkey → allow (anti-lockout)", () => {
    expect(
      decidePassphraseAllowance({ passkeyOnly: true, hasRegisteredPasskey: false }).kind,
    ).toBe("allow_passphrase");
  });
  it("on with passkey → deny", () => {
    expect(
      decidePassphraseAllowance({ passkeyOnly: true, hasRegisteredPasskey: true }).kind,
    ).toBe("deny_passphrase");
  });
  it("sentinel", () => {
    expect(() => {
      throw new PassphraseDeniedByPasskeyOnlyError();
    }).toThrow();
  });
});

describe("M5 githubReleasesProviderPlanner", () => {
  it("snapshot tag round-trip", () => {
    const tag = buildSnapshotTag(DEFAULT_GH_SNAPSHOT_TAG_PREFIX, "2026-05-21T22:00:00Z");
    expect(isSnapshotTag(tag, DEFAULT_GH_SNAPSHOT_TAG_PREFIX)).toBe(true);
    expect(tag).not.toMatch(/[:]/); // sanitised
  });
  it("sentinel", () => {
    expect(() => {
      throw new GhReleasesProviderNotImplementedError();
    }).toThrow();
  });
});

describe("M2 s3ProviderPlanner", () => {
  it("bucket name validation", () => {
    expect(isValidBucketName("acme-prod-backups")).toBe(true);
    expect(isValidBucketName("AB")).toBe(false);
    expect(isValidBucketName("UPPER")).toBe(false);
    expect(isValidBucketName("dots..bad")).toBe(false);
    expect(isValidBucketName("1.2.3.4")).toBe(false);
    expect(isValidBucketName("-leading")).toBe(false);
  });
  it("key prefix handling", () => {
    expect(s3ObjectKeyForCloudPath("/VSCodeSyncFiles/w1/file.ts")).toBe(
      "VSCodeSyncFiles/w1/file.ts",
    );
    expect(s3ObjectKeyForCloudPath("VSCodeSyncFiles/w1/file.ts", "/team/")).toBe(
      "team/VSCodeSyncFiles/w1/file.ts",
    );
  });
  it("sentinel", () => {
    expect(() => {
      throw new S3ProviderNotImplementedError();
    }).toThrow();
  });
});

describe("X2 trustedTeammatesInvitePlanner", () => {
  const payload = (overrides: Partial<TrustInvitePayload> = {}): TrustInvitePayload => {
    const expiresAtMs = Date.now() + 60_000;
    const machineId = "trusted-machine-1";
    const machineName = "Alice's laptop";
    const sig = signTrustInvite(
      { machineId, machineName, expiresAtMs, ...overrides },
      "secret",
    );
    return { machineId, machineName, expiresAtMs, signature: sig, ...overrides };
  };

  it("round-trip with valid signature", () => {
    const p = payload();
    const token = encodeTrustInvite(p);
    const r = decodeTrustInvite(token, "secret");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.machineId).toBe(p.machineId);
  });

  it("expired", () => {
    const p: TrustInvitePayload = {
      machineId: "m",
      machineName: "M",
      expiresAtMs: Date.now() - 1000,
      signature: signTrustInvite(
        { machineId: "m", machineName: "M", expiresAtMs: Date.now() - 1000 },
        "secret",
      ),
    };
    const r = decodeTrustInvite(encodeTrustInvite(p), "secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("bad signature", () => {
    const p = payload();
    const r = decodeTrustInvite(encodeTrustInvite(p), "wrong-secret");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_signature");
  });

  it("malformed input", () => {
    const r = decodeTrustInvite("not-base64-actually-or-json", "secret");
    expect(r.ok).toBe(false);
  });
});
