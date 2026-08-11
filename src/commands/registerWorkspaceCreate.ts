/**
 * Workspace create / connect bundle — final tranche of the
 * `extension.ts` decomposition (v2.6.5 fully closed).
 *
 * Holds 2 commands that establish workspace presence — `createWorkspace`
 * (new workspace + optional template add) and `connectCloudWorkspace`
 * (attach existing cloud workspaces with overlap probe). Both go
 * through `runWithEngine` and need `WorkspaceConfigManager` /
 * `writeSyncPreviewOutput` plus the AI path-mapper auto-prompt.
 *
 * **Bug fix:** `connectCloudWorkspace` previously incremented an
 * undeclared `connected` variable — a real ReferenceError under ES
 * module strict mode (esbuild transpile silently bundled it). Declared
 * locally as `let connected = 0` inside the runWithEngine callback.
 */
import * as vscode from "vscode";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { writeSyncPreviewOutput } from "../ui/syncPreviewUi.js";
import type { RunWithEngineFn } from "./registerWorkspaceLifecycle.js";

const CFG_SECTION = "vscodesync";

export interface WorkspaceCreateCommandsDeps {
  context: vscode.ExtensionContext;
  runWithEngine: RunWithEngineFn;
}

export function registerWorkspaceCreateCommands(
  deps: WorkspaceCreateCommandsDeps,
): vscode.Disposable[] {
  const { context, runWithEngine } = deps;

  return [
    vscode.commands.registerCommand("vscodesync.createWorkspace", async () => {
      const note =
        (await vscode.window.showInputBox({
          title: "VSCodeSync: новый workspace",
          placeHolder: "Описание / название проекта",
        })) ?? "";
      if (!note) {
        return;
      }
      await runWithEngine(async (engine, _root, gc) => {
        const cfg = await gc.load();
        const t = cfg.activeProvider ?? "onedrive";
        try {
          const existing = await engine.listRemoteWorkspaceSummaries();
          const duplicate = existing.find(
            (w) => w.workspaceNote.trim().toLowerCase() === note.trim().toLowerCase(),
          );
          if (duplicate) {
            const proceed = await vscode.window.showWarningMessage(
              `VSCodeSync: workspace с названием «${duplicate.workspaceNote}» уже существует в облаке (${duplicate.workspaceId}). Создать ещё один?`,
              { modal: true },
              "Создать",
            );
            if (proceed !== "Создать") {
              return;
            }
          }
        } catch {
          // Non-fatal: listing may fail if cloud is unreachable
        }
        const wid = await engine.createWorkspace(note, t);

        type TemplateItem = vscode.QuickPickItem & { globs: string[] };
        const templateItems: TemplateItem[] = [
          { label: "$(dash) Без файлов", description: "Пустой workspace, добавить файлы позже", globs: [] },
          { label: "$(key) .env файлы", description: "**/.env, **/.env.*, **/dotenv*", globs: ["**/.env", "**/.env.*", "**/dotenv*"] },
          { label: "$(gear) config/", description: "config/**, *.config.*, *.json (верхний уровень)", globs: ["config/**", "*.config.*", "*.json"] },
          { label: "$(terminal) scripts/ / bin/", description: "scripts/**, bin/**", globs: ["scripts/**", "bin/**"] },
          { label: "$(code) src/ / lib/", description: "src/**, lib/**", globs: ["src/**", "lib/**"] },
          { label: "$(list-ordered) Весь проект", description: "** — все файлы (осторожно: может быть много)", globs: ["**"] },
        ];
        const templatePick = await vscode.window.showQuickPick<TemplateItem>(templateItems, {
          placeHolder: "Начальный набор файлов (опционально)",
          title: `Шаблон для «${note}»`,
        });

        if (templatePick && templatePick.globs.length > 0) {
          const exclude = "{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.vscode/**}";
          const uris: vscode.Uri[] = [];
          for (const glob of templatePick.globs) {
            const found = await vscode.workspace.findFiles(glob, exclude, 500);
            for (const u of found) {
              if (!uris.some((x) => x.fsPath === u.fsPath)) {
                uris.push(u);
              }
            }
          }
          if (uris.length === 0) {
            void vscode.window.showInformationMessage(`VSCodeSync: файлы по шаблону не найдены. Workspace создан: ${wid}.`);
          } else {
            const cfg2 = vscode.workspace.getConfiguration(CFG_SECTION);
            const warnThreshold = cfg2.get<number>("batchAddWarnThreshold", 50);
            if (uris.length > warnThreshold) {
              const ok = await vscode.window.showWarningMessage(
                `VSCodeSync: найдено ${String(uris.length)} файлов. Добавить все в workspace «${note}»?`,
                { modal: true },
                "Добавить",
              );
              if (ok !== "Добавить") {
                void vscode.window.showInformationMessage(`Workspace создан: ${wid} (без файлов).`);
                return;
              }
            }
            await engine.addFiles(wid, uris.map((u) => u.fsPath));
            void vscode.window.showInformationMessage(
              `Workspace «${note}» создан и добавлено ${String(uris.length)} файлов.`,
            );
          }
        } else {
          void vscode.window.showInformationMessage(`Workspace создан: ${wid}`);
        }
      });
    }),

    vscode.commands.registerCommand("vscodesync.connectCloudWorkspace", async () => {
      await runWithEngine(async (engine, root, gc) => {
        const list = await engine.listRemoteWorkspaceSummaries();
        if (list.length === 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: в облаке не найдено ни одного workspace (папка VSCodeSyncFiles пуста или нет доступа).",
          );
          return;
        }
        const cfg = await gc.load();
        const activeProvider = cfg.activeProvider ?? "onedrive";
        const wc = await WorkspaceConfigManager.load(root);
        const alreadyAttached = new Set(wc.activeWorkspaces.map((w) => w.workspaceId));

        type WsPick = vscode.QuickPickItem & { workspaceId: string; providerType?: string };
        const items: WsPick[] = list
          .filter((w) => !alreadyAttached.has(w.workspaceId))
          .map((w) => ({
            label: w.workspaceNote || w.workspaceId,
            description: w.workspaceId,
            workspaceId: w.workspaceId,
          }));

        if (items.length === 0) {
          void vscode.window.showInformationMessage(
            "VSCodeSync: все доступные workspace уже подключены в этом проекте.",
          );
          return;
        }

        const picks = await vscode.window.showQuickPick<WsPick>(items, {
          placeHolder: "Выберите workspace на облаке (можно несколько)",
          canPickMany: true,
        });
        if (!picks || picks.length === 0) {
          return;
        }

        // Dry-run preview before connecting
        const previewChannel = vscode.window.createOutputChannel("VSCodeSync: Dry-run Connect");
        const previewPlan = await engine.previewSyncPlan();
        if (previewPlan.length > 0) {
          writeSyncPreviewOutput(previewChannel, previewPlan);
          const doConnect = await vscode.window.showInformationMessage(
            `VSCodeSync: подключение ${String(picks.length)} workspace(ов). Текущий план sync показан в Output → «VSCodeSync: Dry-run Connect». Продолжить?`,
            { modal: true },
            "Подключить",
          );
          if (doConnect !== "Подключить") {
            previewChannel.dispose();
            return;
          }
        }
        previewChannel.dispose();

        const locallyTracked = new Set(wc.files.map((f) => f.localPath));
        // Bug fix: previously `connected` was used without declaration —
        // worked because esbuild transpiled the file but failed under ES
        // module strict mode at runtime. Local declaration restores intent.
        let connected = 0;
        for (const pick of picks) {
          try {
            const cloudFiles = await engine.listCloudWorkspaceFiles(pick.workspaceId);
            const overlaps = cloudFiles.filter((p) => locallyTracked.has(p));
            if (overlaps.length > 0) {
              const sample = overlaps.slice(0, 5).join("\n  ");
              const more = overlaps.length > 5 ? `\n  …и ещё ${String(overlaps.length - 5)}` : "";
              const proceed = await vscode.window.showWarningMessage(
                `VSCodeSync: workspace «${pick.label}» содержит файлы, уже отслеживаемые другим workspace:\n\n  ${sample}${more}\n\nПодключение добавит их в оба workspace. Продолжить?`,
                { modal: true },
                "Подключить",
              );
              if (proceed !== "Подключить") {
                continue;
              }
            }
          } catch {
            /* non-fatal: overlap check failed (network), proceed anyway */
          }
          try {
            await engine.attachCloudWorkspace(pick.workspaceId);
            connected++;
            // Link Bindings: no silent placement decision — say where files
            // land and that any of them can be re-bound afterwards.
            void vscode.window.showInformationMessage(
              `«${pick.label}»: файлы будут разложены по структуре отправителя (или по вашим папочным привязкам). ` +
                "Отдельный файл можно перепривязать: ПКМ в дереве → Pull → «Выбрать папку и имя…».",
            );
            void (async () => {
              const { maybePromptPathMapperAfterAttach } = await import("../ui/aiPathMapperCommand.js");
              await maybePromptPathMapperAfterAttach(context, pick.workspaceId);
            })();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await vscode.window.showErrorMessage(
              `VSCodeSync: не удалось подключить «${pick.label}» (${pick.workspaceId}) — ${msg}`,
            );
          }
        }

        const wcAfter = await WorkspaceConfigManager.load(root);
        const mismatch = wcAfter.activeWorkspaces.filter(
          (w) => w.providerType != null && w.providerType !== activeProvider,
        );
        if (mismatch.length > 0) {
          const names = mismatch.map((w) => `«${w.workspaceNote || w.workspaceId}»`).join(", ");
          await vscode.window.showWarningMessage(
            `VSCodeSync: ${names} — провайдер в манифесте (${mismatch[0]?.providerType ?? "?"}) отличается от активного (${activeProvider}). Файлы синхронизируются, но рекомендуется миграция (VSCodeSync: Migrate Provider).`,
          );
        }

        if (connected > 0) {
          void vscode.window.showInformationMessage(
            `VSCodeSync: подключено ${String(connected)} workspace(ов).`,
          );
        }
      });
    }),
  ];
}
