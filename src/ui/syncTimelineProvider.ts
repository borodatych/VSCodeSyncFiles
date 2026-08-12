import * as vscode from "vscode";
import { loadActivityFile, type ActivityEvent } from "../core/activityLog.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { trackedLocalAbsolutePath } from "../core/pathMapping.js";
import { manifestKeyOf } from "../core/trackedPathResolver.js";
import type { TrackedFile } from "../core/types.js";

const KIND_ICON: Record<string, string> = {
  push: "$(arrow-up)",
  pull: "$(arrow-down)",
  conflict: "$(warning)",
  resolve_keep_mine: "$(check)",
  resolve_take_theirs: "$(check)",
  add: "$(add)",
  remove: "$(trash)",
};

const KIND_LABEL: Record<string, string> = {
  push: "vsync: push",
  pull: "vsync: pull",
  conflict: "vsync: conflict",
  resolve_keep_mine: "vsync: resolved (keep mine)",
  resolve_take_theirs: "vsync: resolved (take theirs)",
  add: "vsync: added",
  remove: "vsync: removed",
};

/**
 * Provides VSCodeSync sync events in the VSCode Timeline view.
 * Uses runtime registration (Timeline API is stable in VSCode 1.44+ but not in @types/vscode@1.80).
 */
export class SyncTimelineProvider implements vscode.Disposable {
  readonly id = "vscodesync";
  readonly label = "VSCodeSync";

  private readonly _onDidChange = new vscode.EventEmitter<undefined>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly globalConfig: GlobalConfigManager,
  ) {}

  fireChange(): void {
    this._onDidChange.fire(undefined);
  }

  async provideTimeline(uri: vscode.Uri): Promise<{ items: unknown[] }> {
    if (uri.scheme !== "file") {
      return { items: [] };
    }
    const fsPath = uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return { items: [] };
    }
    const root = folder.uri.fsPath;
    const gc = await this.globalConfig.load();
    const storageDir = this.globalConfig.getStorageDir();

    const wc = await WorkspaceConfigManager.load(root);
    let row: TrackedFile | undefined;
    for (const f of wc.files) {
      let abs: string;
      try {
        abs = trackedLocalAbsolutePath(root, wc.pathMapping, gc.machineName, f.localPath);
      } catch {
        continue;
      }
      if (abs === fsPath) {
        row = f;
        break;
      }
    }

    if (!row) {
      return { items: [] };
    }

    const activity = await loadActivityFile(storageDir);
    // Identity first (Link Bindings): `relPath` freezes the placement at event
    // time, so events from before a rename or a physical move would drop out
    // of the trail. The linkId match keeps them; path matches cover events
    // recorded before linkId rode the activity log.
    const rowLinkId = row.linkId;
    const paths = new Set([row.localPath, manifestKeyOf(row)]);
    const relevant = activity.events
      .filter((ev) =>
        rowLinkId !== undefined && ev.linkId !== undefined
          ? ev.linkId === rowLinkId
          : paths.has(ev.relPath),
      )
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 50);

    const items = relevant.map((ev: ActivityEvent) => ({
      timestamp: new Date(ev.at).getTime(),
      label: `${KIND_ICON[ev.kind] ?? "$(sync)"} ${ev.machineName} · ${KIND_LABEL[ev.kind] ?? `vsync: ${ev.kind}`}`,
      description: ev.workspaceNote || ev.workspaceId,
      detail: ev.detail,
      id: ev.id,
      command: {
        command: ev.kind === "push" || ev.kind === "pull"
          ? "vscodesync.showFileHistory"
          : "vscodesync.diffWithCloud",
        title: ev.kind === "push" || ev.kind === "pull" ? "Show File History" : "Diff with Cloud",
        arguments: [uri],
      },
    }));

    return { items };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
