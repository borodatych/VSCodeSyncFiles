/**
 * Cross-cutting — central registry of webview panel kinds with their
 * `WebviewPanelOptions`/`WebviewOptions` shape so the four v3 webviews
 * (visualMerger, syncReplayViewer, quotaDashboard, passkeySettings) plus
 * existing panels (machineGraph, sankey, activityFeed, quickTransferDrop)
 * use one source of truth.
 *
 * Why: every UI command currently builds these options inline. Drift
 * between viewType strings and `retainContextWhenHidden` flags is a
 * regression magnet. This module hands the engine a single typed lookup.
 *
 * No `vscode` import. The shape is structurally compatible with
 * `vscode.WebviewPanelOptions & vscode.WebviewOptions` so callers can
 * pass it directly into `createWebviewPanel`.
 */

export type WebviewKind =
  | "visualMerger"
  | "syncReplayViewer"
  | "quotaDashboard"
  | "passkeySettings"
  | "machineGraph"
  | "sankey"
  | "activityFeed"
  | "quickTransferDrop"
  | "divergences";

export interface WebviewKindDescriptor {
  /** Stable id used by `createWebviewPanel(viewType, ...)` and consumed by
   * the test harness in `packageJsonCommandsConsistency`-style assertions. */
  viewType: string;
  /** Default panel title shown in the tab. */
  title: string;
  /** When true, panel state persists when the user switches away — at the
   * cost of memory. We only set this for panels with non-trivial state
   * the user would otherwise lose. */
  retainContextWhenHidden: boolean;
  /** When true, the webview can run JavaScript. All v3 webviews need this
   * for interactivity; static-only panels keep it off. */
  enableScripts: boolean;
  /** When true, command links inside markdown can navigate to internal
   * commands (`command:vscodesync.foo`). Default false — most panels do
   * not surface command-linked text. */
  enableCommandUris: boolean;
}

const REGISTRY: Record<WebviewKind, WebviewKindDescriptor> = {
  visualMerger: {
    viewType: "vscodesync.visualMerger",
    title: "Visual 3-way Merge",
    retainContextWhenHidden: true,
    enableScripts: true,
    enableCommandUris: false,
  },
  syncReplayViewer: {
    viewType: "vscodesync.syncReplayViewer",
    title: "Sync Replay",
    retainContextWhenHidden: true,
    enableScripts: true,
    enableCommandUris: true,
  },
  quotaDashboard: {
    viewType: "vscodesync.quotaDashboard",
    title: "API Quota Dashboard",
    retainContextWhenHidden: false,
    enableScripts: true,
    enableCommandUris: false,
  },
  passkeySettings: {
    viewType: "vscodesync.passkeySettings",
    title: "Passkey Settings",
    retainContextWhenHidden: true,
    enableScripts: true,
    enableCommandUris: false,
  },
  machineGraph: {
    viewType: "vscodesync.machineGraph",
    title: "Machines & Workspaces",
    retainContextWhenHidden: false,
    enableScripts: true,
    enableCommandUris: false,
  },
  sankey: {
    viewType: "vscodesync.sankey",
    title: "Push/Pull Flows",
    retainContextWhenHidden: false,
    enableScripts: true,
    enableCommandUris: false,
  },
  activityFeed: {
    viewType: "vscodesync.activityFeed",
    title: "Activity Feed",
    retainContextWhenHidden: true,
    enableScripts: true,
    enableCommandUris: true,
  },
  quickTransferDrop: {
    viewType: "vscodesync.quickTransferDrop",
    title: "Quick Transfer Drop",
    retainContextWhenHidden: false,
    enableScripts: true,
    enableCommandUris: false,
  },
  divergences: {
    viewType: "vscodesync.divergences",
    title: "VSCodeSync · Расхождения",
    // Selection is the user's work in progress — losing ten ticked checkboxes
    // to a tab switch would be worse than the memory it costs to keep them.
    retainContextWhenHidden: true,
    enableScripts: true,
    // The panel routes every action through a closed message protocol; command
    // URIs would reintroduce "any command by name from the webview".
    enableCommandUris: false,
  },
};

export function getWebviewKindDescriptor(kind: WebviewKind): WebviewKindDescriptor {
  return REGISTRY[kind];
}

export function listWebviewKinds(): WebviewKind[] {
  return Object.keys(REGISTRY) as WebviewKind[];
}

/** Build the `WebviewPanelOptions & WebviewOptions` payload for
 * `createWebviewPanel`. Caller adds `localResourceRoots` /
 * `portMapping` if needed (those are environment-dependent). */
export interface BuiltWebviewOptions {
  retainContextWhenHidden: boolean;
  enableScripts: boolean;
  enableCommandUris: boolean;
}

export function buildWebviewOptions(kind: WebviewKind): BuiltWebviewOptions {
  const d = getWebviewKindDescriptor(kind);
  return {
    retainContextWhenHidden: d.retainContextWhenHidden,
    enableScripts: d.enableScripts,
    enableCommandUris: d.enableCommandUris,
  };
}

/** Validator helper: returns the set of viewType strings registered.
 * Used by `tests/unit/webviewPanelKindRegistry.test.ts` to assert no
 * collisions across kinds. */
export function listRegisteredViewTypes(): string[] {
  return Object.values(REGISTRY).map((d) => d.viewType);
}
