/**
 * Вопрос пользователю, когда подключённый облачный воркспейс расходится с файлами на диске
 *
 * Общий для всех мест подключения: дерево, мастер подключения, импорт структуры
 * Выбор «Сравнить» открывает панель только после подключения: пока оно идёт,
 * Пересчёт панели столкнулся бы с ним за один и тот же конфиг
 */
import * as vscode from "vscode";
import type { AttachDivergenceChoice, AttachDivergenceSummary } from "../core/attachDivergence.js";

export interface AttachDivergencePromptHandle {
  /** Передаётся в `attachCloudWorkspace` как `onDivergedAfterAttach` */
  onDivergedAfterAttach: (summary: AttachDivergenceSummary) => Promise<AttachDivergenceChoice>;
  /** Вызывается после успешного подключения: открывает «Расхождения», если выбрано сравнение */
  afterAttach: () => Promise<void>;
}

const TAKE_CLOUD = "Взять из облака";
const COMPARE = "Сравнить";
const PUSH_LOCAL = "Отправить своё";
const CONFIRM_PUSH = "Отправить";

export function createAttachDivergencePrompt(root: string, workspaceLabel: string): AttachDivergencePromptHandle {
  let choice: AttachDivergenceChoice = "none";
  let workspaceId = "";
  return {
    onDivergedAfterAttach: async (summary) => {
      workspaceId = summary.workspaceId;
      const more = summary.count > summary.samplePaths.length ? "\n…" : "";
      const picked = await vscode.window.showWarningMessage(
        `В облаке воркспейс «${workspaceLabel}» отличается от файлов на этом компьютере: ${String(summary.count)} файлов. Что сделать?`,
        {
          modal: true,
          detail:
            `${summary.samplePaths.join("\n")}${more}\n\n` +
            "«Взять из облака» — локальные версии сохранятся в локальный бэкап.\n" +
            "Закрыть окно — ничего не трогать, расхождения останутся в панели.",
        },
        TAKE_CLOUD,
        COMPARE,
        PUSH_LOCAL,
      );
      choice = await decide(picked);
      return choice;
    },
    afterAttach: async () => {
      if (choice !== "compare") return;
      await vscode.commands.executeCommand("vscodesync.openDivergences", { root, workspaceId });
    },
  };
}

async function decide(picked: string | undefined): Promise<AttachDivergenceChoice> {
  if (picked === TAKE_CLOUD) return "take_cloud";
  if (picked === COMPARE) return "compare";
  if (picked !== PUSH_LOCAL) return "none";
  // Отправка перезаписывает облако на всех машинах — второе подтверждение обязательно
  const sure = await vscode.window.showWarningMessage(
    "Отправить локальные версии в облако поверх облачных?",
    { modal: true, detail: "Облачные версии сохранятся в истории файлов." },
    CONFIRM_PUSH,
  );
  return sure === CONFIRM_PUSH ? "push_local" : "none";
}
