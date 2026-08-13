/**
 * Backup verification — "could I actually restore from the secondary cloud?"
 *
 * The mirror job (`crossCloudBackup.ts`) copies manifests and `_meta.json` to
 * a second provider; nothing until now ever checked that what landed there is
 * complete and fresh. Both pure halves already existed and had no caller:
 * `planBackupVerify` (primary vs secondary diff) and `planBackupVerifyTick`
 * (when to run). This module is the wiring: read both manifests, compare,
 * report.
 *
 * Reading is all it does — a divergent backup is reported, never "fixed"
 * behind the user's back. Re-mirroring is the existing copy flow, which asks.
 */
import * as vscode from "vscode";
import type { CloudManifest } from "../core/cloudLayout.js";
import { manifestCloudPath } from "../core/cloudLayout.js";
import {
  planBackupVerify,
  scoreVerifyReport,
  type BackupManifestEntry,
  type BackupVerifyReport,
  type BackupVerifySeverity,
} from "../core/backupVerifyPlanner.js";
import {
  DEFAULT_VERIFY_INTERVAL_MS,
  planBackupVerifyTick,
} from "../core/backupVerifyScheduler.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { warnLog } from "../utils/log.js";

const LAST_RUN_KEY = "vscodesync.backupVerify.lastRunMs";
const LAST_SEVERITY_KEY = "vscodesync.backupVerify.lastSeverity";
const STARTUP_DELAY_MS = 120_000;
const POLL_INTERVAL_MS = 60 * 60_000;

export interface BackupVerifyDeps {
  registry: ProviderRegistry;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
  /** Same resolver the mirror job uses for the secondary provider. */
  getAuthenticatedSecondary: (type: string) => Promise<ICloudProvider | null>;
}

/** `_meta.json`-independent view of a manifest, in the planner's shape. */
function manifestEntries(m: CloudManifest): BackupManifestEntry[] {
  const out: BackupManifestEntry[] = [];
  for (const f of m.files) {
    if (f.removedAt) continue;
    const updated = Date.parse(m.updatedAt);
    out.push({
      relPath: f.path,
      // The manifest carries identity and versions, not content hashes; the
      // version acts as the comparable token here. A mismatch means the two
      // clouds disagree about which revision is current, which is exactly
      // the thing a restore would get wrong.
      hash: String(f.version),
      updatedAtMs: Number.isNaN(updated) ? 0 : updated,
    });
  }
  return out;
}

async function fetchManifest(
  provider: ICloudProvider,
  workspaceId: string,
): Promise<CloudManifest | null> {
  try {
    const dl = await provider.downloadFile(manifestCloudPath(workspaceId));
    return JSON.parse(dl.body.toString("utf8")) as CloudManifest;
  } catch {
    return null;
  }
}

export interface WorkspaceVerifyOutcome {
  workspaceId: string;
  workspaceNote: string;
  report: BackupVerifyReport | null;
  severity: BackupVerifySeverity | "no_backup";
}

/** Compare every active workspace against the secondary cloud. Read-only. */
export async function runBackupVerify(deps: BackupVerifyDeps): Promise<WorkspaceVerifyOutcome[]> {
  const cfg = vscode.workspace.getConfiguration("vscodesync");
  const secondary = cfg.get<string>("backup.secondaryProvider", "");
  if (!secondary) return [];
  const primary = await deps.tryAuthenticatedProvider();
  if (!primary || primary.type === secondary) return [];
  const target = await deps.getAuthenticatedSecondary(secondary);
  if (!target) return [];

  const out: WorkspaceVerifyOutcome[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
    for (const aw of wc.activeWorkspaces) {
      const [pm, sm] = await Promise.all([
        fetchManifest(primary, aw.workspaceId),
        fetchManifest(target, aw.workspaceId),
      ]);
      if (!pm) continue;
      if (!sm) {
        out.push({
          workspaceId: aw.workspaceId,
          workspaceNote: aw.workspaceNote,
          report: null,
          severity: "no_backup",
        });
        continue;
      }
      const report = planBackupVerify(aw.workspaceId, manifestEntries(pm), manifestEntries(sm));
      out.push({
        workspaceId: aw.workspaceId,
        workspaceNote: aw.workspaceNote,
        report,
        severity: scoreVerifyReport(report),
      });
    }
  }
  return out;
}

/** Worst severity across workspaces — what the scheduler stores and reports. */
export function worstSeverity(
  outcomes: readonly WorkspaceVerifyOutcome[],
): BackupVerifySeverity {
  const ladder: BackupVerifySeverity[] = ["ok", "drift", "stale", "broken"];
  let worst: BackupVerifySeverity = "ok";
  for (const o of outcomes) {
    const s: BackupVerifySeverity = o.severity === "no_backup" ? "broken" : o.severity;
    if (ladder.indexOf(s) > ladder.indexOf(worst)) worst = s;
  }
  return worst;
}

export function describeOutcomes(outcomes: readonly WorkspaceVerifyOutcome[]): string[] {
  return outcomes.map((o) => {
    if (o.severity === "no_backup") {
      return `❌ «${o.workspaceNote}» — копии во втором облаке нет`;
    }
    const r = o.report;
    const icon = o.severity === "ok" ? "✅" : o.severity === "broken" ? "❌" : "⚠";
    const detail =
      r === null
        ? ""
        : ` — совпало ${String(r.matchCount)} из ${String(r.primaryEntryCount)}` +
          (r.mismatchCount > 0 ? `, расхождений ${String(r.mismatchCount)}` : "");
    return `${icon} «${o.workspaceNote}»${detail}`;
  });
}

/**
 * Background cadence. The tick only *checks* — a failing backup surfaces as a
 * warning with a button; nothing is copied or repaired automatically (B12:
 * the interval is a reminder, not an actor).
 */
export function registerBackupVerify(
  context: vscode.ExtensionContext,
  deps: BackupVerifyDeps,
  channel: vscode.OutputChannel,
): void {
  let running = false;
  const guarded = (): void => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await tick(context, deps, channel);
      } catch (e) {
        warnLog("backupVerify", e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
      }
    })();
  };
  const initial = setTimeout(guarded, STARTUP_DELAY_MS);
  const interval = setInterval(guarded, POLL_INTERVAL_MS);
  context.subscriptions.push(
    new vscode.Disposable(() => { clearTimeout(initial); }),
    new vscode.Disposable(() => { clearInterval(interval); }),
  );
}

async function tick(
  context: vscode.ExtensionContext,
  deps: BackupVerifyDeps,
  channel: vscode.OutputChannel,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("vscodesync");
  const enabled =
    cfg.get<string>("backup.secondaryProvider", "") !== "" &&
    cfg.get<boolean>("backup.verifyEnabled", true);
  const intervalDays = cfg.get<number>("backup.verifyIntervalDays", 1);
  const decision = planBackupVerifyTick({
    enabled,
    lastRunMs: context.globalState.get<number>(LAST_RUN_KEY) ?? null,
    lastSeverity: context.globalState.get<BackupVerifySeverity>(LAST_SEVERITY_KEY) ?? null,
    nowMs: Date.now(),
    intervalMs: Math.max(1, intervalDays) * 24 * 3600_000 || DEFAULT_VERIFY_INTERVAL_MS,
  });
  if (decision.action !== "verify_now") return;

  const outcomes = await runBackupVerify(deps);
  await context.globalState.update(LAST_RUN_KEY, Date.now());
  if (outcomes.length === 0) return;
  const severity = worstSeverity(outcomes);
  await context.globalState.update(LAST_SEVERITY_KEY, severity);
  reportToChannel(channel, outcomes);
  if (severity === "ok") return;

  const picked = await vscode.window.showWarningMessage(
    severity === "broken"
      ? "VSCodeSync: резервная копия во втором облаке неполная — восстановиться из неё сейчас нельзя."
      : "VSCodeSync: резервная копия во втором облаке отстала от основного.",
    "Показать отчёт",
    "Позже",
  );
  if (picked === "Показать отчёт") {
    channel.show(true);
  }
}

function reportToChannel(
  channel: vscode.OutputChannel,
  outcomes: readonly WorkspaceVerifyOutcome[],
): void {
  channel.clear();
  channel.appendLine(`VSCodeSync · проверка резервной копии — ${new Date().toLocaleString()}`);
  channel.appendLine("");
  for (const line of describeOutcomes(outcomes)) {
    channel.appendLine(line);
  }
  const withMismatch = outcomes.filter((o) => (o.report?.mismatchCount ?? 0) > 0);
  if (withMismatch.length > 0) {
    channel.appendLine("");
    channel.appendLine("Расхождения:");
    for (const o of withMismatch) {
      for (const m of o.report?.mismatches.slice(0, 20) ?? []) {
        channel.appendLine(`  ${o.workspaceNote}: ${m.relPath} — ${m.kind}`);
      }
    }
  }
}
