/**
 * Snapshot diff command — picks two snapshots of the current workspace,
 * picks a file present in either, downloads both blobs into a temp dir, and
 * opens VS Code's built-in diff editor (`vscode.diff`).
 *
 * Pure planning + label formatting in `core/snapshotDiffViewer.ts`. The
 * `runSnapshotDiff` deps shape lets the existing `runWithEngine` /
 * `tryAuthenticatedProvider` plumbing inject the cloud provider.
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { listWorkspaceSnapshots } from "../core/snapshotsEngine.js";
import { snapshotFilePath } from "../core/cloudLayout.js";
import { planSnapshotDiff, unionSnapshotFiles } from "../core/snapshotDiffViewer.js";

export interface SnapshotDiffDeps {
  /** Resolve the cloud provider for the current active workspace folder. */
  getProvider(): Promise<ICloudProvider | null>;
  /** Pick which workspaceId to diff against (undefined → ask the user). */
  pickWorkspaceId(): Promise<string | undefined>;
}

export async function runSnapshotDiff(deps: SnapshotDiffDeps): Promise<void> {
  const provider = await deps.getProvider();
  if (!provider) {
    await vscode.window.showWarningMessage("VSCodeSync: облачный провайдер не подключён.");
    return;
  }
  const workspaceId = await deps.pickWorkspaceId();
  if (!workspaceId) return;

  const snapshots = await listWorkspaceSnapshots(provider, workspaceId);
  if (snapshots.length < 2) {
    await vscode.window.showInformationMessage(
      `VSCodeSync: для diff нужно минимум 2 snapshot'а в этом workspace (сейчас ${String(snapshots.length)}).`,
    );
    return;
  }
  const items = snapshots.map((s) => ({
    label: s.name,
    description: `${s.category} · ${s.meta.createdAt}`,
    detail: `${String(s.meta.files.length)} file(s) · ${s.meta.machineName}`,
    name: s.name,
    files: s.meta.files,
    createdAtMs: Date.parse(s.meta.createdAt) || 0,
  }));
  const left = await vscode.window.showQuickPick(items, {
    title: "Snapshot diff — выберите ЛЕВЫЙ snapshot",
    placeHolder: "Older / baseline",
  });
  if (!left) return;
  const right = await vscode.window.showQuickPick(items.filter((i) => i.name !== left.name), {
    title: "Snapshot diff — выберите ПРАВЫЙ snapshot",
    placeHolder: "Newer / candidate",
  });
  if (!right) return;

  const allFiles = unionSnapshotFiles(left.files, right.files);
  if (allFiles.length === 0) {
    await vscode.window.showInformationMessage("VSCodeSync: оба snapshot'а пустые.");
    return;
  }
  const filePick = await vscode.window.showQuickPick(allFiles, {
    title: `Diff ${left.name} ↔ ${right.name} — выберите файл`,
    placeHolder: "POSIX-relative path",
  });
  if (!filePick) return;

  const leftBuf = await tryDownload(provider, snapshotFilePath(workspaceId, left.name, filePick));
  const rightBuf = await tryDownload(provider, snapshotFilePath(workspaceId, right.name, filePick));

  const plan = planSnapshotDiff({
    relPath: filePick,
    left: { workspaceId, snapshotName: left.name, createdAtMs: left.createdAtMs },
    right: { workspaceId, snapshotName: right.name, createdAtMs: right.createdAtMs },
    leftContent: leftBuf?.toString("utf8") ?? "",
    rightContent: rightBuf?.toString("utf8") ?? "",
  });
  if (plan.identical) {
    await vscode.window.showInformationMessage(
      `VSCodeSync: ${filePick} идентичен между «${left.name}» и «${right.name}».`,
    );
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vscodesync-snap-"));
  const safe = (s: string): string => s.replace(/[/\\:*?"<>|]/g, "_");
  const leftPath = path.join(tmpDir, `${safe(left.name)}__${safe(filePick)}`);
  const rightPath = path.join(tmpDir, `${safe(right.name)}__${safe(filePick)}`);
  await fs.mkdir(path.dirname(leftPath), { recursive: true });
  await fs.mkdir(path.dirname(rightPath), { recursive: true });
  await fs.writeFile(leftPath, leftBuf ?? Buffer.alloc(0));
  await fs.writeFile(rightPath, rightBuf ?? Buffer.alloc(0));
  await vscode.commands.executeCommand(
    "vscode.diff",
    vscode.Uri.file(leftPath),
    vscode.Uri.file(rightPath),
    plan.title,
  );
}

async function tryDownload(provider: ICloudProvider, cloudPath: string): Promise<Buffer | null> {
  try {
    const dl = await provider.downloadFile(cloudPath);
    return dl.body;
  } catch {
    return null;
  }
}
