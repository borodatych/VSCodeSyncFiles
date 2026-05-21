import { describe, expect, it } from "vitest";
import {
  buildFileTooltip,
  syncStatusLabels,
  autoSyncModeLabels,
  actionLabels,
  commonLabels,
} from "../../src/ui/i18nMessages.js";

describe("i18nMessages — central UI string table", () => {
  it("syncStatusLabels has all 6 statuses", () => {
    expect(Object.keys(syncStatusLabels)).toHaveLength(6);
  });

  it("autoSyncModeLabels has off/checkOnly/full", () => {
    expect(autoSyncModeLabels.off).toBeTruthy();
    expect(autoSyncModeLabels.checkOnly).toBeTruthy();
    expect(autoSyncModeLabels.full).toBeTruthy();
  });

  it("actionLabels covers pull/push/cancel/undo", () => {
    expect(actionLabels.pull).toBeTruthy();
    expect(actionLabels.push).toBeTruthy();
    expect(actionLabels.cancel).toBeTruthy();
    expect(actionLabels.undo).toBeTruthy();
  });

  it("commonLabels exposes errorTitle and unknown placeholder", () => {
    expect(commonLabels.errorTitle).toBe("VSCodeSync");
    expect(commonLabels.unknown).toBe("—");
  });

  it("buildFileTooltip composes ws + path + status + editingBy", () => {
    expect(
      buildFileTooltip({
        workspaceNote: "PROMED",
        posixRel: "src/foo.js",
        status: "cloudNewer",
        editingByName: "059-1-ws-346",
      }),
    ).toContain("Облако новее");
    expect(
      buildFileTooltip({
        workspaceNote: "PROMED",
        posixRel: "src/foo.js",
        editingByName: "059-1-ws-346",
      }),
    ).toContain("Редактируется");
    expect(
      buildFileTooltip({ workspaceNote: "PROMED", posixRel: "src/foo.js" }),
    ).not.toContain("Редактируется");
  });
});
