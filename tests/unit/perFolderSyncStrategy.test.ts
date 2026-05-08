import { describe, expect, it } from "vitest";
import { parseStrategyFile, resolveStrategy } from "../../src/core/perFolderSyncStrategy.js";

describe("parseStrategyFile", () => {
  it("parses a typical .vscodesync-strategy file", () => {
    const r = parseStrategyFile(`
      # comment
      node_modules/   never
      secrets/        p2p-only
      .vscode/        local-only
      *               cloud
    `);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rules).toHaveLength(4);
      expect(r.rules[0]?.strategy).toBe("never");
      expect(r.rules[0]?.dirOnly).toBe(true);
    }
  });

  it("rejects unknown strategy", () => {
    const r = parseStrategyFile("foo bogus");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("syntax");
      expect(r.line).toBe(1);
    }
  });

  it("rejects extra fields", () => {
    const r = parseStrategyFile("foo cloud extra");
    expect(r.ok).toBe(false);
  });

  it("ignores blank lines and comments", () => {
    const r = parseStrategyFile("\n# a comment\n   \n*  cloud\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rules).toHaveLength(1);
  });
});

describe("resolveStrategy", () => {
  const rulesText = `
    node_modules/   never
    secrets/        p2p-only
    .vscode/        local-only
    *               cloud
  `;

  it("first matching rule wins (top to bottom)", () => {
    const r = parseStrategyFile(rulesText);
    if (!r.ok) throw new Error("parse failed");
    expect(resolveStrategy("node_modules/x.js", r.rules)).toBe("never");
    expect(resolveStrategy("secrets/key.pem", r.rules)).toBe("p2p-only");
    expect(resolveStrategy(".vscode/settings.json", r.rules)).toBe("local-only");
    expect(resolveStrategy("src/x.ts", r.rules)).toBe("cloud");
  });

  it("falls back to 'cloud' when no rule matches", () => {
    expect(resolveStrategy("anything.txt", [])).toBe("cloud");
  });

  it("rules without trailing slash match the file exactly", () => {
    const r = parseStrategyFile("foo.lock never\n*  cloud");
    if (!r.ok) throw new Error("parse failed");
    expect(resolveStrategy("foo.lock", r.rules)).toBe("never");
    expect(resolveStrategy("foo.lock.bak", r.rules)).toBe("cloud");
  });

  it("** matches across slashes", () => {
    const r = parseStrategyFile("**/build/  never\n* cloud");
    if (!r.ok) throw new Error("parse failed");
    expect(resolveStrategy("a/b/build/out.js", r.rules)).toBe("never");
    expect(resolveStrategy("a/b/src/out.js", r.rules)).toBe("cloud");
  });
});
