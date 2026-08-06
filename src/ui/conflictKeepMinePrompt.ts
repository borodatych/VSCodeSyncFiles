/**
 * Shared "Keep Mine" wrapper: the engine now refuses to overwrite a cloud copy
 * that changed after the conflict was raised (D5), and every entry point into
 * keep-mine has to give the user the same way out.
 */
import * as vscode from "vscode";

export type KeepMineOutcome = "pushed" | "cloud_moved" | "not_conflicting";

/**
 * Runs keep-mine and, when the cloud moved on, asks whether to compare first or
 * to overwrite anyway. Returns `true` when the local version reached the cloud.
 */
export async function keepMineWithCloudMovedPrompt(
  run: (opts?: { force?: boolean }) => Promise<KeepMineOutcome>,
  label: string,
  onCompare?: () => Promise<void>,
): Promise<boolean> {
  const first = await run();
  if (first !== "cloud_moved") {
    return first === "pushed";
  }
  const actions = onCompare
    ? ["Всё равно оставить моё", "Сравнить"]
    : ["Всё равно оставить моё"];
  const choice = await vscode.window.showWarningMessage(
    `VSCodeSync: «${label}» — на облаке появилась версия новее той, по которой был отмечен конфликт. «Оставить моё» перезапишет её (старая уйдёт в .history).`,
    { modal: true },
    ...actions,
  );
  if (choice === "Сравнить") {
    await onCompare?.();
    return false;
  }
  if (choice !== "Всё равно оставить моё") {
    return false;
  }
  return (await run({ force: true })) === "pushed";
}
