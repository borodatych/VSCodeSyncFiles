import { describe, expect, it } from "vitest";
import {
  planBackupVerify,
  scoreVerifyReport,
  type BackupManifestEntry,
} from "../../src/core/backupVerifyPlanner.js";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;

function entry(rel: string, hash: string, updatedAtMs: number): BackupManifestEntry {
  return { relPath: rel, hash, updatedAtMs };
}

describe("planBackupVerify — consistent", () => {
  it("reports consistent=true when every entry matches", () => {
    const both = [entry("a", "h1", NOW), entry("b", "h2", NOW)];
    const r = planBackupVerify("ws1", both, both);
    expect(r.consistent).toBe(true);
    expect(r.matchCount).toBe(2);
    expect(r.mismatches).toEqual([]);
    expect(scoreVerifyReport(r)).toBe("ok");
  });
});

describe("planBackupVerify — missing_in_secondary", () => {
  it("flags entries present in primary but absent in secondary", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "h1", NOW), entry("b", "h2", NOW)],
      [entry("a", "h1", NOW)],
    );
    expect(r.consistent).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0]?.kind).toBe("missing_in_secondary");
    expect(scoreVerifyReport(r)).toBe("broken");
  });
});

describe("planBackupVerify — hash_mismatch vs stale_in_secondary", () => {
  it("flags hash_mismatch when secondary is recent enough but hash differs", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "primary-hash", NOW)],
      [entry("a", "secondary-hash", NOW - 1 * HOUR)],
    );
    expect(r.mismatches[0]?.kind).toBe("hash_mismatch");
    expect(scoreVerifyReport(r)).toBe("broken");
  });

  it("flags stale_in_secondary when secondary lags more than the slack window", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "primary-hash", NOW)],
      [entry("a", "older-hash", NOW - 48 * HOUR)],
    );
    expect(r.mismatches[0]?.kind).toBe("stale_in_secondary");
    expect(scoreVerifyReport(r)).toBe("stale");
  });
});

describe("planBackupVerify — extra_in_secondary", () => {
  it("reports entries present in secondary but absent in primary", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "h", NOW)],
      [entry("a", "h", NOW), entry("orphan", "x", NOW)],
    );
    expect(r.mismatches.some((m) => m.kind === "extra_in_secondary")).toBe(true);
    expect(scoreVerifyReport(r)).toBe("drift");
  });
});

describe("scoreVerifyReport — severity ladder", () => {
  it("ok when consistent", () => {
    const r = planBackupVerify("ws1", [], []);
    expect(scoreVerifyReport(r)).toBe("ok");
  });

  it("broken when any missing OR hash_mismatch", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "h1", NOW)],
      [],
    );
    expect(scoreVerifyReport(r)).toBe("broken");
  });

  it("respects custom freshnessSlackMs option", () => {
    const r = planBackupVerify(
      "ws1",
      [entry("a", "primary-hash", NOW)],
      [entry("a", "older-hash", NOW - 30 * HOUR)],
      { freshnessSlackMs: 60 * HOUR }, // 60h slack — within limit
    );
    expect(r.mismatches[0]?.kind).toBe("hash_mismatch");
  });
});
