/**
 * Shared pieces of the palette command groups (F12).
 *
 * `plannedPaletteCommands.ts` was a 1115-line junk drawer holding 27 commands
 * from seven unrelated domains — pause, snapshots, encryption keys, structure
 * export, panels, diagnostics and workspace layout — behind one registration
 * function. Splitting it by domain is what makes each group readable on its
 * own; this module carries only what genuinely spans them.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GlobalConfigManager } from "../../core/globalConfigManager.js";
import type { SyncEngine } from "../../core/syncEngine.js";
import type { SyncTrigger } from "../../core/syncPolicy.js";
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import type { WorkspacesTreeProvider } from "../../ui/workspacesTree.js";
import type { SnapshotCrypto } from "../../core/snapshotsEngine.js";
import { readSnapshotCrypto } from "../../ui/snapshotCrypto.js";

export const CFG = "vscodesync";

/**
 * What the palette command groups need from `activate()`.
 *
 * Previously `PlannedPaletteExtras` of the single 1115-line module; the shape
 * is unchanged so `extension.ts` keeps passing one object to all seven groups.
 */
export interface PaletteExtras {
  globalConfig: GlobalConfigManager;
  /** Build engine (shared ignore, snapshots, …). */
  makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
    trigger: SyncTrigger,
  ) => SyncEngine;
  refreshAfterLocalConfigChange?: () => void | Promise<void>;
  /** After global session pause ends: preview plan + optional full sync. */
  runAfterSessionResume?: () => void | Promise<void>;
  /** For snapshot commands — authenticated provider. */
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  workspacesTree?: WorkspacesTreeProvider;
  /** For encryption key commands — VSCode SecretStorage. */
  secrets?: import("vscode").SecretStorage;
}

/**
 * Snapshot encryption context for palette commands, or `null` when the command
 * must not proceed (encryption on, key locked) — the user is told why.
 */
export async function requireSnapshotCrypto(
  secrets: import("vscode").SecretStorage | undefined,
): Promise<SnapshotCrypto | null> {
  if (!secrets) {
    await vscode.window.showErrorMessage(
      "VSCodeSync: нет доступа к хранилищу секретов — снапшот не создан.",
    );
    return null;
  }
  const crypto = await readSnapshotCrypto(secrets);
  if (crypto.required && crypto.encrypt === undefined) {
    await vscode.window.showErrorMessage(
      "VSCodeSync: шифрование включено, но ключ недоступен — снапшот не создан. " +
        "Разблокируйте ключ и повторите.",
    );
    return null;
  }
  return crypto;
}


/**
 * Shared "pick cloud workspace + pick local folder + download all files"
 * flow used by Export-to-Folder and Restore-from-Cloud. Returns the target
 * absolute path on success, undefined on cancel/error.
 */
/**
 * `_meta` rows for a cloud workspace, keyed by tracked path. Only `wireGzip`
 * matters here: it decides whether the blob lives under a `.gz` suffix.
 * Missing or unreadable `_meta` yields an empty map, which degrades to the old
 * "assume uncompressed" behaviour rather than failing the whole export.
 */
export async function readCloudMetaRows(
  provider: ICloudProvider,
  workspaceId: string,
): Promise<Record<string, { wireGzip?: boolean } | undefined>> {
  const { metaCloudPath } = await import("../../core/cloudLayout.js");
  const dl = await provider.downloadFile(metaCloudPath(workspaceId)).catch(() => null);
  if (!dl) return {};
  try {
    const parsed = JSON.parse(dl.body.toString("utf8")) as {
      files?: Record<string, { wireGzip?: boolean }>;
    };
    return parsed.files ?? {};
  } catch {
    return {};
  }
}

export async function runCloudExportFlow(
  provider: ICloudProvider,
  pickFolderTitle: string,
): Promise<string | undefined> {
  const { listCloudWorkspacesViaPaths } = await import("../../core/cloudWorkspaceLister.js");
  const cloudWs = await listCloudWorkspacesViaPaths(provider);
  if (cloudWs.length === 0) {
    await vscode.window.showWarningMessage("VSCodeSync: на облаке нет workspace'ов.");
    return undefined;
  }
  type WPick = vscode.QuickPickItem & { workspaceId: string };
  const items: WPick[] = cloudWs.map((w) => ({
    label: w.workspaceNote || w.workspaceId,
    description: `${w.workspaceId} · ${String(w.fileCount)} файлов`,
    workspaceId: w.workspaceId,
  }));
  const picked = await vscode.window.showQuickPick<WPick>(items, { placeHolder: "Workspace" });
  if (!picked) return undefined;

  const folderUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: pickFolderTitle,
  });
  const target = folderUris?.[0]?.fsPath;
  if (!target) return undefined;

  const { manifestCloudPath } = await import("../../core/cloudLayout.js");
  const { blobCloudPath } = await import("../../core/wireCompression.js");
  const { decodeCloudBlob } = await import("../../core/cloudBlobCodec.js");
  const dl = await provider.downloadFile(manifestCloudPath(picked.workspaceId)).catch(() => null);
  if (!dl) {
    await vscode.window.showWarningMessage("VSCodeSync: облачный манифест недоступен.");
    return undefined;
  }
  const { parseManifestSafe } = await import("../../core/manifestValidate.js");
  const parsed = parseManifestSafe(dl.body);
  if (!parsed.ok) {
    await vscode.window.showErrorMessage(`VSCodeSync: облачный манифест невалидный: ${parsed.reason}`);
    return undefined;
  }
  const { planWorkspaceExport, escapingPaths } = await import("../../core/workspaceExportPlan.js");
  const plan = planWorkspaceExport(parsed.value, target);
  if (plan.empty) {
    void vscode.window.showInformationMessage("VSCodeSync: workspace не содержит файлов.");
    return undefined;
  }
  const escapes = escapingPaths(plan);
  if (escapes.length > 0) {
    await vscode.window.showErrorMessage(
      `VSCodeSync: ${String(escapes.length)} путей вне выбранной папки — отказ.`,
    );
    return undefined;
  }
  // Export writes cloud blobs straight to disk without going through the
  // engine, so it has no decryption key. Writing ciphertext into the user's
  // folder while reporting success is worse than refusing.
  if (vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false)) {
    await vscode.window.showErrorMessage(
      "VSCodeSync: экспорт зашифрованного workspace пока не поддерживается — " +
        "на диск попал бы шифротекст. Используйте Pull в подключённую папку.",
    );
    return undefined;
  }

  // `_meta` tells which blobs are stored gzipped. The path used to be built
  // with `trackedFileCloudPath`, i.e. always without the `.gz` suffix, so every
  // compressed file simply failed to download — silently, see below.
  const metaRows = await readCloudMetaRows(provider, picked.workspaceId);

  let failed = 0;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: загрузка файлов…", cancellable: false },
    async (progress) => {
      let done = 0;
      for (const entry of plan.entries) {
        const wireGzip = metaRows[entry.posixRel]?.wireGzip === true;
        try {
          const dlFile = await provider.downloadFile(
            blobCloudPath(picked.workspaceId, entry.posixRel, wireGzip),
          );
          const body = decodeCloudBlob(dlFile.body, wireGzip, {});
          await fs.mkdir(path.dirname(entry.targetAbs), { recursive: true });
          await fs.writeFile(entry.targetAbs, body);
          // `done` used to be incremented outside the `try`, so the progress
          // counter reached 100 % even when nothing had been written.
          done++;
        } catch {
          failed++;
        }
        progress.report({
          message: `${String(done)}/${String(plan.entries.length)}`,
        });
      }
    },
  );
  if (failed > 0) {
    await vscode.window.showWarningMessage(
      `VSCodeSync: экспорт завершён с ошибками — не скачано файлов: ${String(failed)} из ${String(plan.entries.length)}.`,
    );
  }
  return target;
}
