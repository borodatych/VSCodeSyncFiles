import { describe, expect, it } from "vitest";
import { syncSessionPause } from "../../src/core/syncSessionPause.js";

describe("syncSessionPause", () => {
  it("tracks pending saves only while paused and clears when re-pausing", () => {
    syncSessionPause.setPaused(false);
    syncSessionPause.clearPendingDocs();
    syncSessionPause.setPaused(true);
    expect(syncSessionPause.getPendingDocCount()).toBe(0);
    syncSessionPause.notePendingDocSave("C:\\a\\f.ts");
    expect(syncSessionPause.isPaused()).toBe(true);
    expect(syncSessionPause.getPendingDocCount()).toBe(1);
    syncSessionPause.setPaused(false);
    expect(syncSessionPause.isPaused()).toBe(false);
    syncSessionPause.setPaused(true);
    expect(syncSessionPause.getPendingDocCount()).toBe(0);
    syncSessionPause.setPaused(false);
    syncSessionPause.clearPendingDocs();
  });

  it("dedupes pending paths case-insensitively", () => {
    syncSessionPause.setPaused(false);
    syncSessionPause.setPaused(true);
    syncSessionPause.notePendingDocSave("D:/x/Y.ts");
    syncSessionPause.notePendingDocSave("d:\\x\\y.ts");
    expect(syncSessionPause.getPendingDocCount()).toBe(1);
    syncSessionPause.setPaused(false);
    syncSessionPause.clearPendingDocs();
  });
});
