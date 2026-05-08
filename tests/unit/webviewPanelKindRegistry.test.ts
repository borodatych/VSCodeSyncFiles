import { describe, expect, it } from "vitest";
import {
  buildWebviewOptions,
  getWebviewKindDescriptor,
  listRegisteredViewTypes,
  listWebviewKinds,
  type WebviewKind,
} from "../../src/core/webviewPanelKindRegistry.js";

describe("webviewPanelKindRegistry — descriptors", () => {
  it("returns a descriptor for every declared kind", () => {
    const kinds = listWebviewKinds();
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      const d = getWebviewKindDescriptor(kind);
      expect(d.viewType).toMatch(/^vscodesync\.[a-zA-Z0-9]+$/);
      expect(d.title.length).toBeGreaterThan(0);
      expect(typeof d.retainContextWhenHidden).toBe("boolean");
      expect(typeof d.enableScripts).toBe("boolean");
      expect(typeof d.enableCommandUris).toBe("boolean");
    }
  });

  it("uses unique viewType strings — no collisions across kinds", () => {
    const types = listRegisteredViewTypes();
    expect(new Set(types).size).toBe(types.length);
  });

  it("includes all four v3 webview kinds (visualMerger, syncReplay, quota, passkey)", () => {
    const kinds = listWebviewKinds();
    expect(kinds).toContain("visualMerger");
    expect(kinds).toContain("syncReplayViewer");
    expect(kinds).toContain("quotaDashboard");
    expect(kinds).toContain("passkeySettings");
  });
});

describe("webviewPanelKindRegistry — flag policy", () => {
  it("enables scripts for every webview (all current kinds need JS)", () => {
    for (const kind of listWebviewKinds()) {
      expect(getWebviewKindDescriptor(kind).enableScripts).toBe(true);
    }
  });

  it("retains context for stateful webviews only", () => {
    expect(getWebviewKindDescriptor("visualMerger").retainContextWhenHidden).toBe(true);
    expect(getWebviewKindDescriptor("syncReplayViewer").retainContextWhenHidden).toBe(true);
    expect(getWebviewKindDescriptor("passkeySettings").retainContextWhenHidden).toBe(true);
    expect(getWebviewKindDescriptor("activityFeed").retainContextWhenHidden).toBe(true);
  });

  it("does not retain context for stateless dashboards", () => {
    expect(getWebviewKindDescriptor("quotaDashboard").retainContextWhenHidden).toBe(false);
    expect(getWebviewKindDescriptor("machineGraph").retainContextWhenHidden).toBe(false);
    expect(getWebviewKindDescriptor("sankey").retainContextWhenHidden).toBe(false);
    expect(getWebviewKindDescriptor("quickTransferDrop").retainContextWhenHidden).toBe(false);
  });

  it("only enables command URIs where command-linked markdown is rendered", () => {
    const enabled = listWebviewKinds().filter(
      (k) => getWebviewKindDescriptor(k).enableCommandUris,
    );
    expect(enabled.sort()).toEqual<WebviewKind[]>(["activityFeed", "syncReplayViewer"]);
  });
});

describe("buildWebviewOptions", () => {
  it("returns a WebviewPanelOptions+WebviewOptions-shaped object", () => {
    const o = buildWebviewOptions("visualMerger");
    expect(o.enableScripts).toBe(true);
    expect(o.retainContextWhenHidden).toBe(true);
    expect(o.enableCommandUris).toBe(false);
  });

  it("matches the descriptor exactly", () => {
    for (const kind of listWebviewKinds()) {
      const d = getWebviewKindDescriptor(kind);
      const o = buildWebviewOptions(kind);
      expect(o).toEqual({
        retainContextWhenHidden: d.retainContextWhenHidden,
        enableScripts: d.enableScripts,
        enableCommandUris: d.enableCommandUris,
      });
    }
  });
});
