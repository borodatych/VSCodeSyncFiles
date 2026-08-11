/**
 * Tests for `mergeCloudManifests` — invoked when `putManifest` retries on
 * 412 PreconditionFailed. Race-resolution semantics:
 *   - Newer `updatedAt` wins for `workspaceNote`, `gitBranch`.
 *   - Tags / sharedIgnorePatterns are unioned.
 *   - Machines: union by machineId, newer lastSeen wins (delegated).
 *   - Files: delegated to `mergeManifestFiles` (already covered separately).
 *   - workspaceId mismatch throws.
 */
import { describe, it, expect } from "vitest";
import { mergeCloudManifests } from "../../src/core/manifestMerger.js";
import type { CloudManifest } from "../../src/core/cloudLayout.js";

const T1 = "2026-04-01T10:00:00.000Z";
const T2 = "2026-04-02T10:00:00.000Z";

function manifest(overrides: Partial<CloudManifest>): CloudManifest {
  return {
    schemaVersion: 1,
    workspaceId: "ws-uuid",
    workspaceNote: "default",
    providerType: "onedrive",
    createdAt: T1,
    updatedAt: T1,
    files: [],
    machines: [],
    tags: [],
    ...overrides,
  };
}

describe("mergeCloudManifests", () => {
  it("throws on workspaceId mismatch", () => {
    expect(() =>
      mergeCloudManifests(
        manifest({ workspaceId: "a" }),
        manifest({ workspaceId: "b" }),
      ),
    ).toThrow(/workspaceId/);
  });

  it("newer remote wins for workspaceNote", () => {
    const out = mergeCloudManifests(
      manifest({ workspaceNote: "old", updatedAt: T1 }),
      manifest({ workspaceNote: "new", updatedAt: T2 }),
    );
    expect(out.workspaceNote).toBe("new");
  });

  it("local wins for workspaceNote when its updatedAt is newer", () => {
    const out = mergeCloudManifests(
      manifest({ workspaceNote: "local-newer", updatedAt: T2 }),
      manifest({ workspaceNote: "remote-stale", updatedAt: T1 }),
    );
    expect(out.workspaceNote).toBe("local-newer");
  });

  it("tags are unioned (deduplicated)", () => {
    const out = mergeCloudManifests(
      manifest({ tags: ["frontend", "auth"] }),
      manifest({ tags: ["auth", "migration"] }),
    );
    expect(out.tags.sort()).toEqual(["auth", "frontend", "migration"]);
  });

  it("gitBranch: newer-wins; falls back when newer side has none", () => {
    const out1 = mergeCloudManifests(
      manifest({ updatedAt: T1, gitBranch: "main" }),
      manifest({ updatedAt: T2, gitBranch: "feature" }),
    );
    expect(out1.gitBranch).toBe("feature");

    const out2 = mergeCloudManifests(
      manifest({ updatedAt: T2, gitBranch: "feature" }),
      manifest({ updatedAt: T1, gitBranch: "main" }),
    );
    expect(out2.gitBranch).toBe("feature");

    const out3 = mergeCloudManifests(
      manifest({ updatedAt: T1, gitBranch: "main" }),
      manifest({ updatedAt: T2, gitBranch: undefined }),
    );
    // remote newer but has no branch — fall back to local
    expect(out3.gitBranch).toBe("main");
  });

  it("updatedAt is rewritten to a new timestamp (post-merge)", () => {
    const out = mergeCloudManifests(
      manifest({ updatedAt: T1 }),
      manifest({ updatedAt: T2 }),
    );
    expect(out.updatedAt).not.toBe(T1);
    expect(out.updatedAt).not.toBe(T2);
  });

  it("machines: newer lastSeen wins per machineId, union otherwise", () => {
    const out = mergeCloudManifests(
      manifest({
        machines: [
          { machineId: "M1", machineName: "old-name", lastSeen: T1 },
          { machineId: "M2", machineName: "only-local", lastSeen: T1 },
        ],
      }),
      manifest({
        machines: [
          { machineId: "M1", machineName: "new-name", lastSeen: T2 },
          { machineId: "M3", machineName: "only-remote", lastSeen: T2 },
        ],
      }),
    );
    const m1 = out.machines.find((m) => m.machineId === "M1");
    expect(m1?.machineName).toBe("new-name");
    expect(out.machines.map((m) => m.machineId).sort()).toEqual(["M1", "M2", "M3"]);
  });
});

describe("mergeCloudManifests — folderBindings (docs/v2/linkBindings.md)", () => {
  it("union машин; внутри машины по-префиксный LWW на boundAt", () => {
    const local = manifest({
      folderBindings: {
        "M-home": {
          promed: { path: "php", boundAt: "t5" },
          "promed/vendor": { path: "lib", boundAt: "t1" },
        },
      },
    });
    const remote = manifest({
      folderBindings: {
        "M-home": { promed: { path: "php-old", boundAt: "t2" } },
        "M-work": { promed: { path: "promed", boundAt: "t3" } },
      },
    });
    for (const merged of [mergeCloudManifests(local, remote), mergeCloudManifests(remote, local)]) {
      expect(merged.folderBindings).toEqual({
        "M-home": {
          promed: { path: "php", boundAt: "t5" },
          "promed/vendor": { path: "lib", boundAt: "t1" },
        },
        "M-work": { promed: { path: "promed", boundAt: "t3" } },
      });
    }
  });

  it("обе стороны без folderBindings → поле отсутствует (не пустой объект)", () => {
    const merged = mergeCloudManifests(manifest({}), manifest({}));
    expect("folderBindings" in merged).toBe(false);
  });

  it("одна сторона без поля — правила выживают при победе любой стороны", () => {
    const withRules = manifest({
      updatedAt: T2,
      folderBindings: { "M-home": { promed: { path: "php", boundAt: "t1" } } },
    });
    const without = manifest({});
    for (const merged of [mergeCloudManifests(withRules, without), mergeCloudManifests(without, withRules)]) {
      expect(merged.folderBindings).toEqual({ "M-home": { promed: { path: "php", boundAt: "t1" } } });
    }
  });
});
