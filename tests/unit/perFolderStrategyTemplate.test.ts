import { describe, expect, it } from "vitest";
import { parseStrategyFile, type StrategyRule } from "../../src/core/perFolderSyncStrategy.js";
import {
  planStrategyImpact,
  renderStrategyFileTemplate,
  scoreStrategyImpact,
} from "../../src/core/perFolderStrategyTemplate.js";

function rules(text: string): StrategyRule[] {
  const r = parseStrategyFile(text);
  if (!r.ok) throw new Error(`bad fixture: ${r.reason} line ${String(r.line)}`);
  return r.rules;
}

describe("renderStrategyFileTemplate", () => {
  it("includes one commented example per strategy", () => {
    const t = renderStrategyFileTemplate();
    expect(t).toContain("never");
    expect(t).toContain("local-only");
    expect(t).toContain("p2p-only");
    expect(t).toContain("cloud");
  });

  it("documents that first-matching-rule-wins", () => {
    const t = renderStrategyFileTemplate();
    expect(t).toContain("first match wins");
  });
});

describe("planStrategyImpact — bucket aggregation", () => {
  it("places each tracked path into exactly one bucket", () => {
    const r = rules("node_modules/ never\nsecrets/ p2p-only\n.vscode/ local-only\n* cloud");
    const tracked = [
      "node_modules/foo.js",
      "secrets/key.txt",
      ".vscode/settings.json",
      "src/index.ts",
      "src/util.ts",
    ];
    const report = planStrategyImpact(tracked, r);
    const byStrat = Object.fromEntries(
      report.buckets.map((b) => [b.strategy, b.count] as const),
    );
    expect(byStrat).toEqual({ never: 1, "local-only": 1, "p2p-only": 1, cloud: 2 });
    expect(report.totalFiles).toBe(5);
    expect(report.noLongerSyncing).toBe(3);
  });

  it("respects the canonical bucket order regardless of rule order", () => {
    const r = rules("* cloud");
    const report = planStrategyImpact(["a.ts"], r);
    expect(report.buckets.map((b) => b.strategy)).toEqual([
      "never",
      "local-only",
      "p2p-only",
      "cloud",
    ]);
  });

  it("limits sample paths per bucket and keeps insertion order", () => {
    const r = rules("docs/** never\n* cloud");
    const tracked = Array.from({ length: 12 }, (_v, i) => `docs/${String(i)}.md`);
    const report = planStrategyImpact(tracked, r, { sampleLimit: 3 });
    const neverBucket = report.buckets.find((b) => b.strategy === "never");
    expect(neverBucket?.sample).toEqual(["docs/0.md", "docs/1.md", "docs/2.md"]);
    expect(neverBucket?.count).toBe(12);
  });

  it("returns 0 in noLongerSyncing when every file resolves to cloud", () => {
    const r = rules("* cloud");
    const report = planStrategyImpact(["a.ts", "b.ts"], r);
    expect(report.noLongerSyncing).toBe(0);
    expect(scoreStrategyImpact(report)).toBe("noop");
  });
});

describe("scoreStrategyImpact — severity ladder", () => {
  it("returns 'noop' on empty input", () => {
    const report = planStrategyImpact([], []);
    expect(scoreStrategyImpact(report)).toBe("noop");
  });

  it("returns 'info' when only 1-2 files flip out of cloud", () => {
    const r = rules("secret.txt local-only");
    const report = planStrategyImpact(["secret.txt", "src/a.ts", "src/b.ts"], r);
    expect(scoreStrategyImpact(report)).toBe("info");
  });

  it("returns 'warn' when 3-9 files flip out of cloud and no danger triggers", () => {
    const r = rules("docs/** local-only\n* cloud");
    const tracked = [
      "docs/a.md",
      "docs/b.md",
      "docs/c.md",
      "src/x.ts",
      "src/y.ts",
      "src/z.ts",
      "src/w.ts",
    ];
    const report = planStrategyImpact(tracked, r);
    expect(scoreStrategyImpact(report)).toBe("warn");
  });

  it("returns 'danger' when 10+ files are marked never", () => {
    const r = rules("logs/** never\n* cloud");
    const tracked = Array.from({ length: 11 }, (_v, i) => `logs/${String(i)}.log`).concat([
      "src/keep.ts",
    ]);
    const report = planStrategyImpact(tracked, r);
    expect(scoreStrategyImpact(report)).toBe("danger");
  });

  it("returns 'danger' when more than half of tracked files leave cloud", () => {
    const r = rules("a/** local-only\n* cloud");
    const tracked = [
      "a/1.ts",
      "a/2.ts",
      "a/3.ts",
      "a/4.ts",
      "a/5.ts",
      "b/1.ts",
      "b/2.ts",
    ];
    const report = planStrategyImpact(tracked, r);
    expect(scoreStrategyImpact(report)).toBe("danger");
  });
});
