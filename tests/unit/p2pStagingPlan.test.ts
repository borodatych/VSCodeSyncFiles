import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { P2P_STAGING_DIR, planP2PStaging } from "../../src/core/p2pStagingPlan.js";

const ROOT = path.resolve("/w/project");

describe("planP2PStaging", () => {
  it("кладёт входящий файл в staging, не в рабочее дерево", () => {
    const r = planP2PStaging(ROOT, "src/app.ts", "abc123");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stagingAbs).toBe(path.join(ROOT, P2P_STAGING_DIR, "abc123", "src", "app.ts"));
    expect(r.targetAbs).toBe(path.join(ROOT, "src", "app.ts"));
    expect(r.relPath).toBe("src/app.ts");
  });

  it("отвергает выход за корень и абсолютные пути", () => {
    expect(planP2PStaging(ROOT, "../../.ssh/config", "t")).toEqual({
      ok: false,
      reason: "escapes_root",
    });
    expect(planP2PStaging(ROOT, "/etc/passwd", "t")).toEqual({ ok: false, reason: "absolute" });
    expect(planP2PStaging(ROOT, "C:/Windows/system.ini", "t")).toEqual({
      ok: false,
      reason: "absolute",
    });
    expect(planP2PStaging(ROOT, "   ", "t")).toEqual({ ok: false, reason: "empty" });
  });

  it("backslash-разделители нормализуются, traversal через них тоже ловится", () => {
    const r = planP2PStaging(ROOT, "src\\app.ts", "t");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relPath).toBe("src/app.ts");
    expect(planP2PStaging(ROOT, "..\\..\\etc\\passwd", "t").ok).toBe(false);
  });

  it("transferId не может стать путём: чистится до [A-Za-z0-9_-]", () => {
    const r = planP2PStaging(ROOT, "a.txt", "../../evil");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.stagingAbs).toBe(path.join(ROOT, P2P_STAGING_DIR, "evil", "a.txt"));
    const empty = planP2PStaging(ROOT, "a.txt", "///");
    expect(empty.ok && empty.stagingAbs).toBe(
      path.join(ROOT, P2P_STAGING_DIR, "unknown", "a.txt"),
    );
  });
});
