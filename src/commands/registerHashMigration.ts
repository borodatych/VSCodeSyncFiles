/**
 * v2.3.4 — BLAKE3 migration palette commands.
 *
 *   - vscodesync.checkBlake3Migration: read-only report. Walks every active
 *     workspace's `_meta.json`, computes per-workspace BLAKE3 coverage, then
 *     consults `planBlake3MigrationAction` (with the dual-workflow start
 *     timestamp from `globalState`) to recommend an action.
 *
 * The `completeBlake3Migration` task-runner that backfills missing
 * `hashBlake3` columns over local files is left as a follow-up — it requires
 * an engine-side `pushMetaJson` path that this command doesn't currently
 * have. The check command alone is enough for the user to see whether the
 * `dual` workflow is ready to flip to `blake3`-only.
 */
import * as vscode from "vscode";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { metaCloudPath } from "../core/cloudLayout.js";
import {
  runHashAlgoMigrationCheck,
  type HashMigrationMetaEntry,
} from "../core/hashMigrationCheck.js";
import {
  planBlake3MigrationAction,
  type CanonicalHashAlgo,
} from "../core/blake3MigrationDecision.js";
import { warnLog } from "../utils/log.js";

const CFG = "vscodesync";
const DUAL_STARTED_KEY = "vscodesync.canonicalHashAlgo.dualWorkflowStartedMs";

export interface HashMigrationCommandsDeps {
  context: vscode.ExtensionContext;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

interface MetaShape {
  files?: Record<string, { hash?: string; hashBlake3?: string }>;
}

/**
 * Pull `_meta.json` for one workspace and surface its entries for the
 * migration helpers. Returns an empty array on missing / malformed meta —
 * the planner treats empty workspaces as `safeToSwitch`.
 */
async function readMetaForMigration(
  provider: ICloudProvider,
  workspaceId: string,
): Promise<HashMigrationMetaEntry[]> {
  try {
    const res = await provider.downloadFile(metaCloudPath(workspaceId));
    if (res.notModified || res.body.length === 0) return [];
    const parsed = JSON.parse(res.body.toString("utf8")) as MetaShape;
    const files = parsed.files;
    if (!files || typeof files !== "object") return [];
    const out: HashMigrationMetaEntry[] = [];
    for (const [relPath, entry] of Object.entries(files)) {
      if (typeof entry.hash !== "string") continue;
      const row: HashMigrationMetaEntry = { relPath, hash: entry.hash };
      if (typeof entry.hashBlake3 === "string") row.hashBlake3 = entry.hashBlake3;
      out.push(row);
    }
    return out;
  } catch (e) {
    if (e instanceof ProviderError && e.code === "NOT_FOUND") return [];
    warnLog("hash-migration", `meta read failed for ${workspaceId}: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

function readSetting(): CanonicalHashAlgo {
  const raw = vscode.workspace.getConfiguration(CFG).get<string>("canonicalHashAlgo", "sha256");
  return raw === "blake3" || raw === "dual" ? raw : "sha256";
}

/** Re-stamp the `dual` workflow start timestamp in `globalState` whenever the
 * setting flips from non-dual to `dual`. Idempotent: stays put once written. */
function ensureDualStartTimestamp(
  context: vscode.ExtensionContext,
  setting: CanonicalHashAlgo,
  nowMs: number,
): number | null {
  const stored = context.globalState.get<number>(DUAL_STARTED_KEY);
  if (setting !== "dual") {
    if (stored !== undefined) {
      // User flipped away from dual — clear so future re-enables restart the
      // grace window.
      void context.globalState.update(DUAL_STARTED_KEY, undefined);
    }
    return null;
  }
  if (stored !== undefined) return stored;
  void context.globalState.update(DUAL_STARTED_KEY, nowMs);
  return nowMs;
}

export function registerHashMigrationCommands(
  deps: HashMigrationCommandsDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.checkBlake3Migration", async () => {
      const provider = await deps.tryAuthenticatedProvider();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        await vscode.window.showWarningMessage("VSCodeSync: откройте папку проекта.");
        return;
      }
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      if (wc.activeWorkspaces.length === 0) {
        await vscode.window.showInformationMessage("VSCodeSync: нет активных workspace.");
        return;
      }
      const nowMs = Date.now();
      const setting = readSetting();
      const dualStartedMs = ensureDualStartTimestamp(deps.context, setting, nowMs);

      const reports: { workspaceId: string; entries: HashMigrationMetaEntry[] }[] = [];
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: BLAKE3 migration check…" },
        async () => {
          for (const ws of wc.activeWorkspaces) {
            const entries = await readMetaForMigration(provider, ws.workspaceId);
            reports.push({ workspaceId: ws.workspaceId, entries });
          }
        },
      );

      const global = runHashAlgoMigrationCheck(reports);
      const decision = planBlake3MigrationAction({
        currentSetting: setting,
        dualWorkflowStartedMs: dualStartedMs,
        nowMs,
        completedRatio: global.ratioWithBlake3,
      });

      const channel = vscode.window.createOutputChannel("VSCodeSync · BLAKE3 migration");
      channel.clear();
      channel.appendLine(`Setting: ${setting}`);
      channel.appendLine(
        `Dual workflow started: ${dualStartedMs ? new Date(dualStartedMs).toISOString() : "—"}`,
      );
      channel.appendLine("");
      channel.appendLine("Per-workspace coverage:");
      for (const ws of global.perWorkspace) {
        const id = ws.workspaceId.slice(0, 8);
        const pct = (ws.ratioWithBlake3 * 100).toFixed(1);
        channel.appendLine(`  ${id}  ${String(ws.withBlake3)}/${String(ws.totalEntries)} (${pct}%)`);
      }
      channel.appendLine("");
      channel.appendLine(`Total: ${String(global.totalWithBlake3)}/${String(global.totalEntries)} (${(global.ratioWithBlake3 * 100).toFixed(1)}%)`);
      channel.appendLine(`Recommendation: ${decision.action} — ${decision.reason}`);
      switch (decision.action) {
        case "stay_sha256":
          channel.appendLine("Setting `vscodesync.canonicalHashAlgo` is `sha256` — no migration in progress. Flip to `dual` first.");
          break;
        case "stay_dual":
          channel.appendLine("Continue running on `dual`. Re-check after the grace window or once coverage rises above 95%.");
          break;
        case "recommend_switch":
          channel.appendLine("Coverage ≥ 95% and grace window has elapsed. You can switch to `blake3` once you're satisfied with the remaining entries (legacy entries will keep matching via SHA-256).");
          break;
        case "safe_to_switch_now":
          channel.appendLine("Coverage is 100% (or setting is already `blake3`). Safe to switch.");
          break;
      }
      channel.show(true);
    }),
  ];
}
