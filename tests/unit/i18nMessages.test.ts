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
        workspaceNote: "alpha-workspace",
        posixRel: "src/foo.js",
        status: "cloudNewer",
        editingByName: "work-laptop",
      }),
    ).toContain("Облако новее");
    expect(
      buildFileTooltip({
        workspaceNote: "alpha-workspace",
        posixRel: "src/foo.js",
        editingByName: "work-laptop",
      }),
    ).toContain("Редактируется");
    expect(
      buildFileTooltip({ workspaceNote: "alpha-workspace", posixRel: "src/foo.js" }),
    ).not.toContain("Редактируется");
  });
});
