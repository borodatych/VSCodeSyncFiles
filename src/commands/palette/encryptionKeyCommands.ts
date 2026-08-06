/**
 * Encryption keys — palette commands.
 *
 * Ключ шифрования: экспорт под паролем, импорт, ротация с перешифровкой облака.
 *
 * Вынесено из `ui/plannedPaletteCommands.ts` (F12): 27 команд из семи доменов
 * жили в одном файле на 1115 строк, и добавление любой новой команды делало
 * его ещё менее читаемым.
 */
import * as vscode from "vscode";
import { createWorkspaceSnapshot } from "../../core/snapshotsEngine.js";
import { exportKeyWithPassword, importKeyWithPassword, generateEncryptionKey, encryptBuffer, decryptBuffer } from "../../core/encryption.js";
import { readEncryptionKey, storeEncryptionKey } from "../../core/encryptionKey.js";
import { WorkspaceConfigManager } from "../../core/workspaceConfigManager.js";
import type { PaletteExtras } from "./_shared.js";
import { CFG } from "./_shared.js";

export function registerEncryptionKeyCommands(
  context: vscode.ExtensionContext,
  extras: PaletteExtras,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("vscodesync.exportEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const key = await readEncryptionKey(secrets);
      if (!key) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: ключ шифрования не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль для защиты файла ключа (не меньше 8 символов)",
        password: true,
        validateInput: (v) => (v.length >= 8 ? null : "Минимум 8 символов"),
      });
      if (!password) {
        return;
      }
      const blob = await exportKeyWithPassword(key, password);
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(".vscodesync-key.enc"),
        filters: { "VSCodeSync Key": ["enc"] },
      });
      if (!uri) {
        return;
      }
      const { writeFile, mkdir } = await import("node:fs/promises");
      const nodePath = await import("node:path");
      await mkdir(nodePath.dirname(uri.fsPath), { recursive: true });
      await writeFile(uri.fsPath, blob);
      void vscode.window.showInformationMessage(
        "VSCodeSync: ключ экспортирован. Сохраните файл в безопасном месте — без него расшифровать данные невозможно.",
      );
    }),

    vscode.commands.registerCommand("vscodesync.importEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const openResult = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "VSCodeSync Key": ["enc"] },
      });
      const fileUri = openResult?.[0];
      if (!fileUri) {
        return;
      }
      const password = await vscode.window.showInputBox({
        prompt: "Пароль от файла ключа",
        password: true,
      });
      if (password === undefined) {
        return;
      }
      try {
        const { readFile } = await import("node:fs/promises");
        const blob = await readFile(fileUri.fsPath);
        const key = await importKeyWithPassword(blob, password);
        await storeEncryptionKey(secrets, key);
        void vscode.window.showInformationMessage("VSCodeSync: ключ шифрования импортирован и сохранён.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await vscode.window.showErrorMessage(`VSCodeSync: ошибка импорта ключа — ${msg}`);
      }
    }),

    vscode.commands.registerCommand("vscodesync.rotateEncryptionKey", async () => {
      const secrets = extras.secrets;
      if (!secrets) {
        await vscode.window.showErrorMessage("VSCodeSync: недоступно в этой среде.");
        return;
      }
      const encryptionOn = vscode.workspace.getConfiguration(CFG).get<boolean>("encryption", false);
      if (!encryptionOn) {
        await vscode.window.showWarningMessage("VSCodeSync: шифрование не включено (vscodesync.encryption: false).");
        return;
      }
      const oldKey = await readEncryptionKey(secrets);
      if (!oldKey) {
        await vscode.window.showWarningMessage(
          "VSCodeSync: старый ключ не найден. Включите vscodesync.encryption и перезапустите VSCode.",
        );
        return;
      }
      // Exporting the current key first is not advice, it is the recovery path.
      // Rotation rewrites every cloud blob; if it stops half way the only thing
      // that can still read the untouched half is the old key.
      const exportedFirst = await vscode.window.showWarningMessage(
        "VSCodeSync: перед ротацией ключа экспортируйте текущий ключ. " +
          "Если ротация прервётся, только он откроет ещё не перешифрованные файлы.",
        { modal: true },
        "Экспортировать сейчас",
        "Ключ уже сохранён",
      );
      if (exportedFirst === undefined) {
        return;
      }
      if (exportedFirst === "Экспортировать сейчас") {
        await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
      }
      const confirm = await vscode.window.showWarningMessage(
        "VSCodeSync: Ротация ключа шифрования. Перед началом будут созданы авто-снапшоты всех workspace. Все облачные файлы будут перезашифрованы. Продолжить?",
        { modal: true },
        "Начать ротацию",
      );
      if (confirm !== "Начать ротацию") {
        return;
      }
      const provider = await extras.tryAuthenticatedProvider?.();
      if (!provider) {
        await vscode.window.showWarningMessage("VSCodeSync: нет авторизованного провайдера.");
        return;
      }
      const gc = await extras.globalConfig.load();

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "VSCodeSync: ротация ключа…", cancellable: false },
        async (progress) => {
          // Step 1: auto-snapshots. A failure here is fatal, not "non-fatal":
          // the snapshot is the safety net for precisely this operation, and
          // rotating without it means rewriting every blob with no way back.
          const folders = vscode.workspace.workspaceFolders ?? [];
          const snapshotDate = new Date().toISOString().replace(/[:.]/g, "-");
          let totalFiles = 0;
          const snapshotFailures: string[] = [];
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const ws of wc.activeWorkspaces) {
              progress.report({ message: `Снапшот workspace ${ws.workspaceNote || ws.workspaceId}…` });
              try {
                // Encrypted with the *old* key on purpose: the new one is not
                // generated until step 2, and this snapshot is the rollback.
                await createWorkspaceSnapshot(
                  provider,
                  folder.uri.fsPath,
                  ws.workspaceId,
                  `auto-pre-key-rotation-${snapshotDate}`,
                  gc.machineName,
                  {
                    required: true,
                    encrypt: (buf: Buffer) => encryptBuffer(oldKey, buf),
                    decrypt: (buf: Buffer) => decryptBuffer(oldKey, buf),
                  },
                );
              } catch (e) {
                snapshotFailures.push(
                  `${ws.workspaceNote || ws.workspaceId}: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              totalFiles += wc.files.filter((f) => f.workspaceId === ws.workspaceId).length;
            }
          }
          if (snapshotFailures.length > 0) {
            await vscode.window.showErrorMessage(
              "VSCodeSync: ротация отменена — не удалось создать страховочные снапшоты:\n" +
                snapshotFailures.join("\n"),
            );
            return;
          }

          // Step 2: Generate new key
          const newKey = generateEncryptionKey();
          progress.report({ message: "Перешифровка файлов…" });

          // Step 3: re-encrypt every tracked blob, remembering what succeeded.
          const reEncrypted: string[] = [];
          const failures: { cloudPath: string; localPath: string; error: string }[] = [];
          let seen = 0;
          for (const folder of folders) {
            const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
            for (const file of wc.files) {
              if (!file.cloudPath) {
                continue;
              }
              seen++;
              progress.report({ message: `${String(seen)}/${String(totalFiles)}: ${file.localPath}` });
              try {
                const dl = await provider.downloadFile(file.cloudPath);
                const plaintext = decryptBuffer(oldKey, dl.body);
                const newCiphertext = encryptBuffer(newKey, plaintext);
                await provider.uploadFile(file.cloudPath, newCiphertext, { ifMatch: dl.etag });
                reEncrypted.push(file.cloudPath);
              } catch (e) {
                failures.push({
                  cloudPath: file.cloudPath,
                  localPath: file.localPath,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
          }

          // Step 4: the key is stored only when every blob was rewritten.
          //
          // It used to be stored unconditionally, right after a loop that
          // swallowed every per-file error. Any file that failed re-encryption
          // stayed under the old key, which was then overwritten — the file
          // became permanently unreadable, and the report still claimed success.
          if (failures.length === 0) {
            await storeEncryptionKey(secrets, newKey);
            await extras.refreshAfterLocalConfigChange?.();
            void vscode.window
              .showInformationMessage(
                `VSCodeSync: ротация ключа завершена. Перешифровано файлов: ${String(reEncrypted.length)}. Экспортируйте новый ключ.`,
                "Экспортировать",
              )
              .then(async (choice) => {
                if (choice === "Экспортировать") {
                  await vscode.commands.executeCommand("vscodesync.exportEncryptionKey");
                }
              });
            return;
          }

          // Rollback: both keys are still in hand, so the blobs already rewritten
          // can be put back under the old key and the old key kept in place.
          progress.report({ message: "Откат: возвращаю перешифрованные файлы под старый ключ…" });
          const rollbackFailures: string[] = [];
          for (const cloudPath of reEncrypted) {
            try {
              const dl = await provider.downloadFile(cloudPath);
              const plaintext = decryptBuffer(newKey, dl.body);
              await provider.uploadFile(cloudPath, encryptBuffer(oldKey, plaintext), {
                ifMatch: dl.etag,
              });
            } catch (e) {
              rollbackFailures.push(`${cloudPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          if (rollbackFailures.length === 0) {
            await vscode.window.showErrorMessage(
              `VSCodeSync: ротация отменена и полностью откачена. Ключ НЕ изменён. ` +
                `Не удалось перешифровать файлов: ${String(failures.length)} ` +
                `(${failures.slice(0, 3).map((f) => f.localPath).join(", ")}${failures.length > 3 ? ", …" : ""}). ` +
                "Устраните причину и повторите.",
            );
            return;
          }

          // Partial rollback: some blobs are under the new key and cannot be put
          // back. Keeping the old key would make exactly those unreadable, so the
          // new key wins and the user is told precisely which files need the
          // exported old key.
          await storeEncryptionKey(secrets, newKey);
          await extras.refreshAfterLocalConfigChange?.();
          await vscode.window.showErrorMessage(
            "VSCodeSync: ротация завершилась частично. Новый ключ сохранён, потому что откатить удалось не всё.\n" +
              `Под НОВЫМ ключом: ${String(reEncrypted.length - rollbackFailures.length)} файлов и ещё ${String(rollbackFailures.length)}, которые не удалось вернуть.\n` +
              `Под СТАРЫМ ключом остались: ${failures.map((f) => f.localPath).join(", ")}.\n` +
              "Восстановите их экспортированным старым ключом или из авто-снапшота " +
              `auto-pre-key-rotation-${snapshotDate}.`,
          );
        },
      );
    }),
  );
}
