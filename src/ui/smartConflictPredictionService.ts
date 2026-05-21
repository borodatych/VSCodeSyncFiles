/**
 * Smart Conflict Prediction — live UI surface.
 *
 * Watches the active editor: when the open file is tracked AND another
 * machine has marked itself as currently editing the same file (via the
 * existing per-file `editingBy` / `editingByName` fields populated by the
 * soft-lock pipeline), surfaces a status-bar warning.
 *
 * Pure scoring + activeOthers extraction live in
 * `core/smartConflictPrediction.ts`.
 *
 * Limitations:
 *  - Only sees `editingBy` records that the existing soft-lock pipeline
 *    already propagated through the cloud manifest. The "presence wire"
 *    full path (per-path editingBy in _machines.json with sub-second
 *    heartbeat) remains future work.
 *  - Detection is best-effort, scoped to the active editor; we don't
 *    walk every open editor on every keystroke.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { GlobalConfigManager } from "../core/globalConfigManager.js";
import {
  scoreConflictRisk,
  type OtherMachineEdit,
} from "../core/smartConflictPrediction.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { parseMachinesRegistry } from "../core/machineRegistry.js";
import { machinesRegistryCloudPath } from "../core/cloudLayout.js";
import {
  createPresenceCache,
  findHighRiskPeer,
  type PresenceCache,
} from "../core/presenceCacheTTL.js";
import { warnLog } from "../utils/log.js";

const REFRESH_INTERVAL_MS = 30_000;
/** v2.9.3 — interval at which the presence reader polls `_machines.json`.
 * Slower than the UI refresh so we don't hammer the provider; the local
 * cache (PresenceCache TTL 60s) keeps the UI responsive. */
const PRESENCE_FETCH_INTERVAL_MS = 60_000;

export class SmartConflictPredictionService implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private readonly presenceCache: PresenceCache = createPresenceCache();
  private lastPresenceFetchMs = 0;

  constructor(
    private readonly globalConfig: GlobalConfigManager,
    private readonly tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      "vscodesync.smartConflictPrediction",
      vscode.StatusBarAlignment.Left,
      90,
    );
    this.statusBar.name = "VSCodeSync · Conflict prediction";
  }

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => { void this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(() => { void this.refresh(); }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("vscodesync.smartConflictPrediction")) {
          void this.refresh();
        }
      }),
    );
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_INTERVAL_MS);
    if (this.tryAuthenticatedProvider) {
      this.presenceTimer = setInterval(() => { void this.fetchPresence(); }, PRESENCE_FETCH_INTERVAL_MS);
      void this.fetchPresence();
    }
    void this.refresh();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.presenceTimer !== null) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.statusBar.dispose();
  }

  /** v2.9.3 — pull `_machines.json` and refresh the in-memory presence cache.
   *  v0.8 — guarded by `lastPresenceFetchMs` so back-to-back triggers
   *  (e.g. editor flip + save in <1s) don't double up the provider call. */
  private async fetchPresence(): Promise<void> {
    if (!this.tryAuthenticatedProvider) return;
    const nowMs = Date.now();
    // Throttle: skip if we already fetched within the last (interval − 1s).
    // Allows the timer-driven fetch to always succeed, while debouncing
    // ad-hoc callers that may invoke fetchPresence sooner.
    if (nowMs - this.lastPresenceFetchMs < PRESENCE_FETCH_INTERVAL_MS - 1_000) {
      return;
    }
    this.lastPresenceFetchMs = nowMs;
    try {
      const provider = await this.tryAuthenticatedProvider();
      if (!provider) return;
      const cloudPath = machinesRegistryCloudPath();
      const res = await provider.downloadFile(cloudPath);
      if (res.notModified || res.body.length === 0) return;
      const entries = parseMachinesRegistry(res.body);
      const gc = await this.globalConfig.load().catch(() => null);
      const myMachineId = gc?.machineId ?? "";
      const receivedAtMs = Date.now();
      for (const e of entries) {
        if (e.machineId === myMachineId) continue;
        if (e.currentEditing === undefined) continue; // unknown — skip
        this.presenceCache.put({
          machineId: e.machineId,
          machineName: e.machineName,
          frame: e.currentEditing,
          receivedAtMs,
        });
      }
    } catch (err) {
      warnLog("smart-conflict", `presence fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async refresh(): Promise<void> {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("smartConflictPrediction.enabled", true);
    if (!enabled) {
      this.statusBar.hide();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme !== "file") {
      this.statusBar.hide();
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
      this.statusBar.hide();
      return;
    }
    const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) {
      this.statusBar.hide();
      return;
    }
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath).catch(() => null);
    if (!wc) {
      this.statusBar.hide();
      return;
    }
    const myMachineName = await this.resolveMachineName();
    const others: OtherMachineEdit[] = wc.files
      .filter(
        (f) =>
          f.localPath === rel &&
          (f.editingBy ?? "") !== "" &&
          (f.editingByName ?? f.editingBy) !== myMachineName,
      )
      .map((f) => ({
        machineName: f.editingByName ?? f.editingBy ?? "",
        relPath: f.localPath,
        startedAtMs: 0,
        // We don't track lastSeenMs locally; treat presence as fresh — the
        // soft-lock pipeline already prunes stale entries via TTL.
        lastSeenMs: Date.now(),
      }));
    const result = scoreConflictRisk({
      myMachineName,
      myEditingPath: rel,
      others,
      nowMs: Date.now(),
    });

    // v2.9.3 — augment with presence reader: peers that have just opened the
    // same file but haven't yet bumped soft-lock fields. Higher signal than
    // soft-lock for "right now" concurrent editing.
    const trackedFile = wc.files.find((f) => f.localPath === rel);
    let presenceHit: { machineName: string; risk: number } | null = null;
    if (trackedFile) {
      const peer = findHighRiskPeer({
        cache: this.presenceCache,
        myWorkspaceId: trackedFile.workspaceId,
        myRelPath: rel,
      });
      if (peer) presenceHit = { machineName: peer.entry.machineName, risk: peer.risk };
    }

    if (result.score === 0 && presenceHit === null) {
      this.statusBar.hide();
      return;
    }
    const score = Math.max(result.score, presenceHit?.risk ?? 0);
    const softLockOthers = result.activeOthers;
    const presenceOthers = presenceHit ? [presenceHit.machineName] : [];
    const who = [...new Set([...softLockOthers, ...presenceOthers])].join(", ");
    this.statusBar.text = `$(warning) Conflict risk: ${who} editing this file`;
    const sourceLine = presenceHit
      ? `\n\nИсточник: ${result.score > 0 ? "soft-lock + " : ""}live presence (\`_machines.json\`).`
      : "";
    this.statusBar.tooltip = new vscode.MarkdownString(
      `**VSCodeSync** · риск конфликта ${(score * 100).toFixed(0)}%.\n\n` +
        `Параллельная работа на: ${who}.${sourceLine}\n\n` +
        `Сохраните и сделайте Push раньше них, либо подождите их sync.`,
    );
    this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.statusBar.show();
  }

  private async resolveMachineName(): Promise<string> {
    try {
      const cfg = await this.globalConfig.load();
      return cfg.machineName;
    } catch {
      return "";
    }
  }
}
