import { describe, expect, it } from "vitest";
import {
  explainFileSyncState,
  formatExplainReportMarkdown,
  type ExplainFileSyncStateInput,
} from "../../src/core/explainFileSyncState.js";

const base = (): ExplainFileSyncStateInput => ({
  workspaceRoot: "/r",
  posixRel: "src/a.ts",
  trusted: true,
  autoSyncMode: "check-only",
  sessionPaused: false,
  autoPauseActive: false,
  rateLimited: false,
  workspaceState: "active",
  tracked: true,
  syncStatus: "ok",
  secondaryReadOnly: false,
});

describe("explainFileSyncState", () => {
  it("happy path: willSync=true, no blocks", () => {
    const r = explainFileSyncState(base());
    expect(r.willSync).toBe(true);
    expect(r.primaryBlock).toBeUndefined();
    expect(r.items.some((i) => i.kind === "ok")).toBe(true);
  });

  it("untrusted blocks first", () => {
    const r = explainFileSyncState({ ...base(), trusted: false });
    expect(r.willSync).toBe(false);
    expect(r.primaryBlock?.id).toBe("trust");
  });

  it("autoSyncMode=off blocks", () => {
    const r = explainFileSyncState({ ...base(), autoSyncMode: "off" });
    expect(r.willSync).toBe(false);
    expect(r.primaryBlock?.id).toBe("auto_mode");
  });

  it("autoSyncMode=check-only is info, not block", () => {
    const r = explainFileSyncState({ ...base(), autoSyncMode: "check-only" });
    expect(r.willSync).toBe(true);
    expect(r.items.find((i) => i.id === "auto_mode")?.kind).toBe("info");
  });

  it("workspace suspended blocks", () => {
    const r = explainFileSyncState({ ...base(), workspaceState: "suspended" });
    expect(r.primaryBlock?.id).toBe("ws_state");
  });

  it("conflict status blocks", () => {
    const r = explainFileSyncState({ ...base(), syncStatus: "conflict" });
    expect(r.primaryBlock?.id).toBe("status");
  });

  it("pending_push is info, not block", () => {
    const r = explainFileSyncState({ ...base(), syncStatus: "pending_push" });
    expect(r.willSync).toBe(true);
  });

  it("soft-lock blocks push", () => {
    const r = explainFileSyncState({
      ...base(),
      editingByOther: { machineName: "Work" },
    });
    expect(r.items.some((i) => i.id === "soft_lock" && i.kind === "block")).toBe(true);
  });

  it("secondary read-only blocks", () => {
    const r = explainFileSyncState({ ...base(), secondaryReadOnly: true });
    expect(r.primaryBlock?.id).toBe("secondary_readonly");
  });

  it("not tracked blocks", () => {
    const r = explainFileSyncState({ ...base(), tracked: false, syncStatus: undefined });
    expect(r.items.find((i) => i.id === "tracked")?.kind).toBe("block");
  });

  it("formatExplainReportMarkdown produces non-empty output", () => {
    const r = explainFileSyncState(base());
    const md = formatExplainReportMarkdown(r);
    expect(md).toContain("src/a.ts");
    expect(md).toContain("✅");
  });

  it("markdown surfaces primary block hint", () => {
    const r = explainFileSyncState({ ...base(), trusted: false });
    const md = formatExplainReportMarkdown(r);
    expect(md).toContain("Главный блокер");
    expect(md).toContain("Trust");
  });
});
