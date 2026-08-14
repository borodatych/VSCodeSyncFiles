/**
 * Порядок в проходе по git-ветке: пауза решается локально и раньше облака.
 *
 * Авто-пауза непривязанных воркспейсов сначала стояла после
 * `tryAuthenticatedProvider()` — то есть за облачным шлагбаумом. Оффлайн,
 * разлогин или форк редактора со своим хранилищем секретов молча отключали
 * функцию, которая вообще не нуждается в сети. Гейт держит порядок: разъехаться
 * снова можно только осознанно, вместе с этим тестом.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "..", "src", "ui", "gitBranchWorkspaceActivation.ts"),
  "utf8",
);

/** Тело прохода: от его объявления до следующего верхнеуровневого экспорта. */
const POLICY_BODY = SRC.slice(
  SRC.indexOf("export async function applyBranchPolicyForRoot("),
  SRC.indexOf("export function registerGitBranchWorkspaceActivation("),
);

describe("applyBranchPolicyForRoot", () => {
  it("вызывает авто-паузу до получения провайдера", () => {
    const pause = POLICY_BODY.indexOf("await applyUnboundBranchPause(");
    const provider = POLICY_BODY.indexOf("await deps.tryAuthenticatedProvider()");
    expect(pause).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(pause).toBeLessThan(provider);
  });

  it("применяет паузу через конфиг, а не через движок", () => {
    const fn = SRC.slice(
      SRC.indexOf("async function applyUnboundBranchPause("),
      SRC.indexOf("export async function applyBranchPolicyForRoot("),
    );
    expect(fn).toContain("WorkspaceConfigManager.mutate");
    expect(fn).not.toContain("engine.setWorkspaceSyncState");
  });

  it("каждый ранний выход прохода объясняет себя в логе", () => {
    const fn = POLICY_BODY;
    // Все `return;` прохода — это ранние выходы; каждому предшествует
    // строка диагностики, иначе симптом читается как «расширение молчит».
    const earlyExits = fn.split("\n").reduce<{ prev: string; bad: string[] }>(
      (acc, line) => {
        if (line.trim() === "return;" && !acc.prev.includes("verboseLog") && !acc.prev.includes("warnLog")) {
          acc.bad.push(acc.prev.trim());
        }
        return { prev: line, bad: acc.bad };
      },
      { prev: "", bad: [] },
    );
    expect(earlyExits.bad).toEqual([]);
  });
});
