import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { isSafeTelemetryIngestUrl } from "./telemetryIngestUrl.js";

const GLOBAL_STATE_LAST_ACTIVATE_DAY = "vscodesync.telemetryLastActivateDay";

export { isSafeTelemetryIngestUrl } from "./telemetryIngestUrl.js";

function extensionTelemetryOptIn(cfgSection: string): boolean {
  return vscode.workspace.getConfiguration(cfgSection).get<boolean>("telemetry", false);
}

/**
 * VS Code–native telemetry: {@link vscode.env.createTelemetryLogger} + optional HTTPS POST
 * when `vscodesync.telemetryIngestUrl` is set. No file paths or names in payloads we build.
 */
export class VsCodeSyncTelemetry implements vscode.Disposable {
  private readonly logger: vscode.TelemetryLogger;
  private readonly cfgSection: string;

  constructor(cfgSection: string) {
    this.cfgSection = cfgSection;
    this.logger = vscode.env.createTelemetryLogger(
      {
        sendEventData: (eventName, data) => {
          this.forwardToIngest("event", eventName, data as Record<string, unknown> | undefined);
        },
        sendErrorData: (error, data) => {
          this.forwardToIngest("error", error.name, {
            ...(data ?? {}),
            errorMessage: error.message,
          });
        },
      },
      { ignoreUnhandledErrors: true },
    );
    setActiveTelemetry(this);
  }

  /** External hook for sub-features (passkey, AI, …) that have their own
   * pure event sanitisers and just need to dispatch the resulting `{ name,
   * data }` through the shared logger. No-op if telemetry is disabled or
   * not yet activated. */
  logSanitisedUsage(name: string, data: Record<string, string | number | boolean | null>): void {
    this.logger.logUsage(name, data);
  }

  private forwardToIngest(kind: string, name: string, data?: Record<string, unknown>): void {
    if (!extensionTelemetryOptIn(this.cfgSection)) {
      return;
    }
    const urlRaw = vscode.workspace.getConfiguration(this.cfgSection).get<string>("telemetryIngestUrl", "");
    const url = typeof urlRaw === "string" ? urlRaw.trim() : "";
    if (!url || !isSafeTelemetryIngestUrl(url)) {
      return;
    }
    const payload = {
      kind,
      name,
      t: Date.now(),
      data: data ?? {},
    };
    void (async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => {
        ac.abort();
      }, 8000);
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
      } catch {
        /* offline / bad endpoint — ignore */
      } finally {
        clearTimeout(timer);
      }
    })();
  }

  /**
   * One aggregated activation event per calendar day (UTC), only if extension + VS Code telemetry are on.
   */
  async maybeLogDailyActivation(context: vscode.ExtensionContext, globalConfig: GlobalConfigManager): Promise<void> {
    if (!extensionTelemetryOptIn(this.cfgSection) || !vscode.env.isTelemetryEnabled) {
      return;
    }
    const day = new Date().toISOString().slice(0, 10);
    const last = context.globalState.get<string>(GLOBAL_STATE_LAST_ACTIVATE_DAY);
    if (last === day) {
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    let activeWorkspaceRows = 0;
    let trackedFileCount = 0;
    for (const folder of folders) {
      const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
      activeWorkspaceRows += wc.activeWorkspaces.length;
      trackedFileCount += wc.files.length;
    }
    const gc = await globalConfig.load();
    const pkg = context.extension.packageJSON as { version?: string };
    const version = pkg.version ?? "0";
    this.logger.logUsage("vscodesync.activate", {
      extensionVersion: version,
      providerType: gc.activeProvider ?? "none",
      workspaceFolderCount: folders.length,
      activeWorkspaceRows,
      trackedFileCount,
    });
    await context.globalState.update(GLOBAL_STATE_LAST_ACTIVATE_DAY, day);
  }

  dispose(): void {
    clearActiveTelemetryIf(this);
    this.logger.dispose();
  }
}

let activeTelemetry: VsCodeSyncTelemetry | undefined;

function setActiveTelemetry(t: VsCodeSyncTelemetry): void {
  activeTelemetry = t;
}

function clearActiveTelemetryIf(t: VsCodeSyncTelemetry): void {
  if (activeTelemetry === t) activeTelemetry = undefined;
}

/** Module-level fan-in for sub-features (passkey, AI, etc.) that don't have
 * their own way to reach the singleton instance. No-op when telemetry isn't
 * active (extension deactivated / never activated). */
export function logSanitisedUsage(
  name: string,
  data: Record<string, string | number | boolean | null>,
): void {
  activeTelemetry?.logSanitisedUsage(name, data);
}

export function registerVsCodeSyncTelemetry(
  context: vscode.ExtensionContext,
  globalConfig: GlobalConfigManager,
  cfgSection: string,
): void {
  const t = new VsCodeSyncTelemetry(cfgSection);
  context.subscriptions.push(t);
  void t.maybeLogDailyActivation(context, globalConfig);
}
