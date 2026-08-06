/**
 * v2.6.7 — wiring for daily/weekly scheduled snapshots, extracted from
 * `extension.ts`. Composes `registerScheduledSnapshots` with the engine
 * pipeline (snapshot create → list → retention prune).
 */
import * as vscode from "vscode";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { tryAuthenticatedProvider } from "../commands/_providerFactory.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { registerScheduledSnapshots } from "../ui/scheduledSnapshots.js";

const CFG_SECTION = "vscodesync";

export interface ScheduledSnapshotsWiringDeps {
  context: vscode.ExtensionContext;
  globalConfig: GlobalConfigManager;
  registry: ProviderRegistry;
}

export function registerScheduledSnapshotsWiring(deps: ScheduledSnapshotsWiringDeps): void {
  const { context, globalConfig, registry } = deps;
  registerScheduledSnapshots(context, {
    getCandidateFolders: () => vscode.workspace.workspaceFolders ?? [],
    snapshotFolder: async (folderRoot) => {
      const wc = await WorkspaceConfigManager.load(folderRoot);
      if (wc.activeWorkspaces.length === 0) return;
      const provider = await tryAuthenticatedProvider(registry);
      if (!provider) return;
      const gc = await globalConfig.load();
      const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
      const retentionDays = cfg.get<number>("snapshotRetentionDays", 180);
      const maxPerWorkspace = cfg.get<number>("maxSnapshotsPerWorkspace", 20);
      const { createWorkspaceSnapshot, listWorkspaceSnapshots, deleteWorkspaceSnapshot } =
        await import("../core/snapshotsEngine.js");
      const { planSnapshotRetention } = await import("../core/snapshotRetentionPlan.js");
      const { readSnapshotCrypto } = await import("../ui/snapshotCrypto.js");
      const snapCrypto = await readSnapshotCrypto(context.secrets);
      // Scheduled snapshots are automatic: with the key locked they are skipped
      // entirely rather than written in the clear.
      if (snapCrypto.required && snapCrypto.encrypt === undefined) {
        return;
      }
      for (const aw of wc.activeWorkspaces) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        try {
          await createWorkspaceSnapshot(
            provider,
            folderRoot,
            aw.workspaceId,
            `auto-${stamp}`,
            gc.machineName,
            snapCrypto,
          );
        } catch {
          continue;
        }
        try {
          const snapshots = await listWorkspaceSnapshots(provider, aw.workspaceId);
          const plan = planSnapshotRetention({ snapshots, retentionDays, maxPerWorkspace });
          for (const s of plan.delete) {
            await deleteWorkspaceSnapshot(provider, aw.workspaceId, s.name);
          }
        } catch {
          /* retention is best-effort — never fail the snapshot itself */
        }
      }
    },
  });
}
