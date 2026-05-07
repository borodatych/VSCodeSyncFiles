import { describe, expect, it } from "vitest";
import { workspaceTreeContextValue } from "../../src/ui/workspaceTreeContext.js";

describe("workspaceTreeContextValue", () => {
  it("active + archived suffix", () => {
    expect(workspaceTreeContextValue("active", ["archived"])).toBe("vscodeSync.workspaceArchivedActive");
  });

  it("suspended without archived", () => {
    expect(workspaceTreeContextValue("suspended", [])).toBe("vscodeSync.workspaceSuspended");
  });

  it("suspended + archived", () => {
    expect(workspaceTreeContextValue("suspended", ["archived"])).toBe("vscodeSync.workspaceArchivedSuspended");
  });

  it("frozen + archived", () => {
    expect(workspaceTreeContextValue("frozen", ["archived"])).toBe("vscodeSync.workspaceArchivedFrozen");
  });
});
