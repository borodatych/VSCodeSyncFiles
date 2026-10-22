import { describe, expect, it } from "vitest";
import { splitBulkPushByFreshStatus } from "../../src/core/bulkPushSplit.js";

const f = (localPath: string, syncStatus: string) => ({ workspaceId: "w", localPath, syncStatus }) as never;

describe("splitBulkPushByFreshStatus", () => {
  it("отделяет cloud_newer и conflict, остальные и неизвестные идут обычной отправкой", () => {
    const files = [f("a", "cloud_newer"), f("b", "conflict"), f("c", "pending_push"), f("d", "ok")];
    const targets = ["a", "b", "c", "d", "e"].map((localPath) => ({ workspaceId: "w", localPath }));
    const r = splitBulkPushByFreshStatus(files, targets);
    expect(r.aheadInCloud.map((t) => t.localPath)).toEqual(["a", "b"]);
    expect(r.plain.map((t) => t.localPath)).toEqual(["c", "d", "e"]);
  });

  it("не путает одинаковые пути разных воркспейсов", () => {
    const files = [{ workspaceId: "w1", localPath: "a", syncStatus: "cloud_newer" }] as never;
    const r = splitBulkPushByFreshStatus(files, [{ workspaceId: "w2", localPath: "a" }]);
    expect(r.aheadInCloud).toEqual([]);
  });
});
