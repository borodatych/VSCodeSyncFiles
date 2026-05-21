import { describe, expect, it } from "vitest";
import {
  groupFilesByWindow,
  isWindowDue,
  matchesGlob,
  resolveWindowForPath,
} from "../../src/core/perGlobScheduler.js";

describe("matchesGlob", () => {
  it("exact match", () => {
    expect(matchesGlob("a.ts", "a.ts")).toBe(true);
  });
  it("single-segment wildcard", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/sub/a.ts", "src/*.ts")).toBe(false);
  });
  it("recursive `**` wildcard", () => {
    expect(matchesGlob("src/a/b/c.ts", "src/**")).toBe(true);
    expect(matchesGlob("docs/x.md", "src/**")).toBe(false);
  });
  it("escapes regex special characters", () => {
    expect(matchesGlob("a.ts", "a.ts")).toBe(true);
    expect(matchesGlob("axts", "a.ts")).toBe(false);
  });
});

describe("resolveWindowForPath", () => {
  it("first matching rule wins", () => {
    const cfg = {
      rules: [
        { pattern: "docs/**", window: "weekly" as const },
        { pattern: "**/*.ts", window: "immediate" as const },
      ],
    };
    expect(resolveWindowForPath(cfg, "docs/readme.md")).toBe("weekly");
    expect(resolveWindowForPath(cfg, "src/main.ts")).toBe("immediate");
  });

  it("falls back to defaultWindow when no rule matches", () => {
    const cfg = { rules: [{ pattern: "docs/**", window: "weekly" as const }], defaultWindow: "nightly" as const };
    expect(resolveWindowForPath(cfg, "x.ts")).toBe("nightly");
  });

  it("immediate by default when no rules + no defaultWindow", () => {
    expect(resolveWindowForPath({ rules: [] }, "x.ts")).toBe("immediate");
  });
});

describe("isWindowDue", () => {
  const now = 10_000_000_000; // arbitrary baseline
  it("immediate is always due", () => {
    expect(isWindowDue("immediate", now - 1000, now)).toBe(true);
  });
  it("never is never due", () => {
    expect(isWindowDue("never", 0, now)).toBe(false);
  });
  it("never-synced (lastSyncMs=0) → due for non-immediate too", () => {
    expect(isWindowDue("weekly", 0, now)).toBe(true);
  });
  it("hourly: 30 min ago → not due; 2h ago → due", () => {
    expect(isWindowDue("hourly", now - 30 * 60_000, now)).toBe(false);
    expect(isWindowDue("hourly", now - 2 * 3600_000, now)).toBe(true);
  });
  it("nightly: 12h ago → not due; 25h ago → due", () => {
    expect(isWindowDue("nightly", now - 12 * 3600_000, now)).toBe(false);
    expect(isWindowDue("nightly", now - 25 * 3600_000, now)).toBe(true);
  });
});

describe("groupFilesByWindow", () => {
  it("buckets files correctly", () => {
    const cfg = {
      rules: [
        { pattern: "docs/**", window: "weekly" as const },
        { pattern: "src/**", window: "immediate" as const },
      ],
    };
    const now = Date.now();
    const out = groupFilesByWindow(cfg, [
      { posixRel: "docs/a.md", lastSyncMs: now - 1000 },
      { posixRel: "src/main.ts", lastSyncMs: now - 1000 },
      { posixRel: "x.txt", lastSyncMs: now },
    ], now);
    expect(out.get("weekly")?.length).toBe(1);
    expect(out.get("immediate")?.length).toBe(2); // src + default x.txt
  });
});
