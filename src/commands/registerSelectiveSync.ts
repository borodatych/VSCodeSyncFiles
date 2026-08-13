/**
 * Selective sync — the command surface: switch the mode, see what it does
 * BEFORE it does it, and edit the pattern list.
 *
 * There is one pattern source in the product (`.vscodesync-ignore` + the
 * manifest's shared patterns + this machine's local ones). The mode decides
 * how the sync pass reads it; see `core/selectiveSyncMode.ts` for why a second
 * pattern file was deliberately not introduced.
 *
 * The preview is the whole point: flipping to `include-list` on a list written
 * as an exclude list inverts the meaning of every line at once. Ten files
 * leaving sync silently is exactly the failure this command exists to prevent.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";
import { buildCombinedIgnoreRules } from "../core/workspaceIgnoreRules.js";
import {
  parseSelectiveSyncMode,
  scoreModeSwitch,
  summariseModeSwitch,
  type SelectiveSyncMode,
} from "../core/selectiveSyncMode.js";
import { pickRoot } from "./_shared.js";

const IGNORE_FILE = ".vscodesync-ignore";

const MODE_LABEL: Record<SelectiveSyncMode, string> = {
  "all-tracked": "Синхронизировать всё отслеживаемое",
  "exclude-list": "Не синхронизировать совпавшее с паттернами",
  "include-list": "Синхронизировать только совпавшее с паттернами",
};

const MODE_DETAIL: Record<SelectiveSyncMode, string> = {
  "all-tracked": "Паттерны действуют при добавлении файлов и ручной отправке (как раньше)",
  "exclude-list": "Совпавшие файлы перестают синхронизироваться на этой машине",
  "include-list": "Всё, кроме совпавшего, перестаёт синхронизироваться на этой машине",
};

export function registerSelectiveSyncCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("vscodesync.selectiveSyncEditList", async () => {
      const root = pickRoot();
      if (!root) {
        return;
      }
      const cfgSection = vscode.workspace.getConfiguration("vscodesync");
      const current = parseSelectiveSyncMode(cfgSection.get<string>("selectiveSync.mode", "all-tracked"));

      const action = await vscode.window.showQuickPick(
        [
          { label: "$(list-selection) Сменить режим", id: "mode" as const },
          { label: `$(edit) Открыть список паттернов (${IGNORE_FILE})`, id: "edit" as const },
        ],
        {
          title: `VSCodeSync — выборочная синхронизация (сейчас: ${MODE_LABEL[current]})`,
          placeHolder: "Что сделать",
        },
      );
      if (!action) return;

      if (action.id === "edit") {
        await openPatternList(root);
        return;
      }

      const modes: SelectiveSyncMode[] = ["all-tracked", "exclude-list", "include-list"];
      const picked = await vscode.window.showQuickPick(
        modes.map((m) => ({
          label: MODE_LABEL[m],
          detail: MODE_DETAIL[m],
          description: m === current ? "текущий" : undefined,
          mode: m,
        })),
        { title: "VSCodeSync — режим выборочной синхронизации" },
      );
      if (!picked || picked.mode === current) return;

      const wc = await WorkspaceConfigManager.load(root);
      const tracked = wc.files.map((f) => f.localPath);
      // One rule set per workspace entry; a project with several workspaces
      // shares the file-level patterns, so the first entry's view is enough
      // for the preview.
      const rules = await buildCombinedIgnoreRules(root, wc.activeWorkspaces[0]);
      const impact = summariseModeSwitch({
        trackedRelPaths: tracked,
        rules,
        prevMode: current,
        nextMode: picked.mode,
      });
      const severity = scoreModeSwitch(impact);

      if (severity !== "noop") {
        const lines: string[] = [];
        if (impact.wouldStop.length > 0) {
          lines.push(`Перестанут синхронизироваться: ${String(impact.wouldStop.length)}`);
          lines.push(...impact.wouldStop.slice(0, 8).map((p) => `  · ${p}`));
          if (impact.wouldStop.length > 8) lines.push(`  …и ещё ${String(impact.wouldStop.length - 8)}`);
        }
        if (impact.wouldStart.length > 0) {
          lines.push(`Начнут синхронизироваться: ${String(impact.wouldStart.length)}`);
        }
        lines.push(`Без изменений: ${String(impact.unchangedCount)}`);
        lines.push("");
        lines.push(
          "Файлы не удаляются: ни с диска, ни из облака. Они остаются отслеживаемыми — " +
            "просто перестают синхронизироваться на этой машине; другие машины продолжают как прежде.",
        );
        const confirmLabel = severity === "danger" ? "Всё равно переключить" : "Переключить";
        const answer = await vscode.window.showWarningMessage(
          `VSCodeSync — «${MODE_LABEL[picked.mode]}»?`,
          { modal: true, detail: lines.join("\n") },
          confirmLabel,
        );
        if (answer !== confirmLabel) return;
      }

      await cfgSection.update(
        "selectiveSync.mode",
        picked.mode,
        vscode.ConfigurationTarget.Workspace,
      );
      void vscode.window.showInformationMessage(
        `VSCodeSync: режим — «${MODE_LABEL[picked.mode]}». ` +
          (impact.wouldStop.length > 0
            ? `Перестали синхронизироваться: ${String(impact.wouldStop.length)} файл(ов).`
            : "Состав синхронизации не изменился."),
      );
    }),
  ];
}

/** Open (creating if absent) the pattern file, with a mode-aware header. */
async function openPatternList(root: string): Promise<void> {
  const uri = vscode.Uri.file(path.join(root, IGNORE_FILE));
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    const template = [
      `# ${IGNORE_FILE} — паттерны в стиле .gitignore.`,
      "# Как они читаются, решает настройка vscodesync.selectiveSync.mode:",
      "#   all-tracked   — только при добавлении файлов и ручной отправке;",
      "#   exclude-list  — совпавшее не синхронизируется;",
      "#   include-list  — синхронизируется ТОЛЬКО совпавшее.",
      "#",
      "# Примеры:",
      "#   secrets/          — папка целиком",
      "#   *.local.json      — по маске",
      "#   build/**          — рекурсивно",
      "",
    ].join("\n");
    await vscode.workspace.fs.writeFile(uri, Buffer.from(template, "utf8"));
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}
