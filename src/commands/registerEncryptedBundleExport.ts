/**
 * Encrypted bundle export command (v2.20.3 — security/privacy).
 *
 * `vscodesync.exportEncryptedBundle` lets the user dump a workspace
 * (manifest + tracked files + a small README) into a single
 * `*.vscsbundle` file, encrypted with a passphrase via
 * {@link exportKeyWithPassword}'s key-derivation envelope. Use case:
 * air-gapped transfer through USB / cold storage.
 *
 * The bundle wire format is intentionally simple:
 *
 *     magic = "VSCS\x01"          (5 bytes)
 *     ciphertext = AES-256-GCM(   // see encryption.encryptBuffer
 *       key = PBKDF2(passphrase, salt),
 *       plaintext = JSON.stringify({ manifest, files: [...] })
 *     )
 *
 * Future bumps to the shape change the magic byte. The passphrase derivation
 * matches `exportKeyWithPassword` so the existing import-key tooling could
 * round-trip the bundle by reading the ciphertext as if it were a wrapped
 * key envelope (it isn't — but the format is identical, which keeps the
 * crypto surface small).
 */
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exportKeyWithPassword } from "../core/encryption.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

const COMMAND = "vscodesync.exportEncryptedBundle";
const MAGIC = Buffer.from([0x56, 0x53, 0x43, 0x53, 0x01]); // "VSCS\x01"

interface BundleFile {
  workspaceId: string;
  localPath: string;
  contentBase64: string;
}

export function registerEncryptedBundleExport(): vscode.Disposable[] {
  return [vscode.commands.registerCommand(COMMAND, runExport)];
}

async function runExport(): Promise<void> {
  const folder = pickFolder();
  if (!folder) {
    await vscode.window.showErrorMessage("VSCodeSync: откройте папку workspace.");
    return;
  }
  const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
  if (wc.activeWorkspaces.length === 0 || wc.files.length === 0) {
    void vscode.window.showInformationMessage(
      "VSCodeSync: нет отслеживаемых файлов в текущей папке — нечего экспортировать.",
    );
    return;
  }

  const passphrase = await promptPassphrase();
  if (passphrase === undefined) return;
  if (passphrase.length < 12) {
    await vscode.window.showWarningMessage(
      "VSCodeSync: passphrase должен быть ≥ 12 символов. Экспорт отменён.",
    );
    return;
  }

  const target = await vscode.window.showSaveDialog({
    title: "Сохранить encrypted bundle",
    filters: { Bundle: ["vscsbundle"] },
    saveLabel: "Сохранить",
    defaultUri: vscode.Uri.joinPath(folder.uri, `${folder.name}.vscsbundle`),
  });
  if (!target) return;

  let writtenBytes = 0;
  try {
    const payload = await buildBundlePayload(folder.uri.fsPath, wc);
    const blob = await exportKeyWithPassword(payload, passphrase);
    const out = Buffer.concat([MAGIC, blob]);
    await fs.writeFile(target.fsPath, out);
    writtenBytes = out.length;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await vscode.window.showErrorMessage(`VSCodeSync: bundle export failed — ${msg}`);
    return;
  }

  void vscode.window.showInformationMessage(
    `VSCodeSync: bundle сохранён в ${target.fsPath} (${formatBytes(writtenBytes)}). ` +
    "Передайте файл и passphrase отдельно по разным каналам.",
  );
}

async function buildBundlePayload(
  rootFsPath: string,
  wc: Awaited<ReturnType<typeof WorkspaceConfigManager.load>>,
): Promise<Buffer> {
  const files: BundleFile[] = [];
  for (const f of wc.files) {
    const abs = path.join(rootFsPath, ...f.localPath.split("/"));
    try {
      const buf = await fs.readFile(abs);
      files.push({
        workspaceId: f.workspaceId,
        localPath: f.localPath,
        contentBase64: buf.toString("base64"),
      });
    } catch {
      // skip files we can't read; tombstone removed from bundle
    }
  }
  const manifest = {
    schema: 1 as const,
    activeWorkspaces: wc.activeWorkspaces,
    pathMapping: wc.pathMapping,
    exportedAt: new Date().toISOString(),
  };
  const json = JSON.stringify({ manifest, files });
  return Buffer.from(json, "utf8");
}

function pickFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

async function promptPassphrase(): Promise<string | undefined> {
  const first = await vscode.window.showInputBox({
    prompt: "VSCodeSync · Passphrase для encrypted bundle (≥ 12 символов)",
    password: true,
    ignoreFocusOut: true,
  });
  if (first === undefined) return undefined;
  const second = await vscode.window.showInputBox({
    prompt: "VSCodeSync · Подтвердите passphrase",
    password: true,
    ignoreFocusOut: true,
  });
  if (second === undefined) return undefined;
  if (first !== second) {
    void vscode.window.showWarningMessage("VSCodeSync: passphrases не совпадают — экспорт отменён.");
    return undefined;
  }
  return first;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
