/**
 * Hover provider that shows a "what would Pull change here" hint over tracked
 * files. Reads only local config (`WorkspaceConfigManager.load`) — no
 * provider round-trips, no blob downloads. Pure formatting in
 * `core/hoverDiffPreview.ts → summariseHoverDiffMinimal`.
 *
 * Skipped silently for:
 *  - non-`file://` URIs (output channels, scratch, etc.)
 *  - documents outside any workspace folder
 *  - files not tracked by VSCodeSync
 *  - files where syncStatus collapses to none / the user disabled the
 *    setting `vscodesync.hoverDiffPreview.enabled`
 *
 * Cache: 5 s TTL per document URI to avoid hammering disk on every hover
 * tick (VS Code calls provideHover for every word the cursor passes over).
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import {
  summariseHoverDiffMinimal,
  type HoverSyncStatus,
} from "../core/hoverDiffPreview.js";

const CACHE_TTL_MS = 5_000;

interface HoverCacheEntry {
  at: number;
  hover: vscode.Hover | null;
}

export class HoverDiffPreviewProvider implements vscode.HoverProvider, vscode.Disposable {
  private readonly cache = new Map<string, HoverCacheEntry>();

  refresh(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.cache.clear();
  }

  async provideHover(document: vscode.TextDocument): Promise<vscode.Hover | null | undefined> {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("hoverDiffPreview.enabled", true);
    if (!enabled) return undefined;
    if (document.uri.scheme !== "file") return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return undefined;

    const key = document.uri.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.hover ?? undefined;
    }

    const rel = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) {
      this.cache.set(key, { at: Date.now(), hover: null });
      return undefined;
    }

    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    const tf = wc.files.find((f) => f.localPath === rel);
    if (!tf) {
      this.cache.set(key, { at: Date.now(), hover: null });
      return undefined;
    }
    const status: HoverSyncStatus | null =
      tf.syncStatus === "cloud_newer" || tf.syncStatus === "conflict" || tf.syncStatus === "ok"
        ? tf.syncStatus
        : null;
    if (status === null) {
      this.cache.set(key, { at: Date.now(), hover: null });
      return undefined;
    }
    const lastSyncAtMs = tf.lastSync ? Date.parse(tf.lastSync) : null;
    const lastSyncByMachine = tf.editingByName ?? tf.editingBy ?? "";
    const text = summariseHoverDiffMinimal({
      relPath: rel,
      syncStatus: status,
      lastSyncAtMs: lastSyncAtMs !== null && Number.isFinite(lastSyncAtMs) ? lastSyncAtMs : null,
      lastSyncByMachine,
    });
    if (!text) {
      this.cache.set(key, { at: Date.now(), hover: null });
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**VSCodeSync** · ${text}`);
    if (status === "cloud_newer") {
      md.appendMarkdown("\n\n[Pull](command:vscodesync.pullCurrentFile)");
    } else if (status === "conflict") {
      md.appendMarkdown("\n\n[Resolve Conflicts](command:vscodesync.resolveConflicts)");
    }
    const hover = new vscode.Hover(md);
    this.cache.set(key, { at: Date.now(), hover });
    return hover;
  }
}
