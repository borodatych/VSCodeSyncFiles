/**
 * Кнопки заголовка панели различимы взглядом.
 *
 * «Фильтровать воркспейсы…» и «Дерево: только расхождения» несли одну и ту же
 * воронку, стояли в одном ряду и путали владельца. Иконка — единственная
 * подпись кнопки в заголовке: две одинаковые означают, что одна из них
 * необъяснима без наведения мыши.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as {
  contributes: {
    commands: { command: string; icon?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
  };
};

const iconOf = new Map(pkg.contributes.commands.map((c) => [c.command, c.icon]));

/** Видимые кнопки заголовка данной панели — те, у кого есть иконка. */
function titleIcons(viewId: string): { command: string; icon: string }[] {
  return (pkg.contributes.menus["view/title"] ?? [])
    .filter((m) => (m.when ?? "").includes(viewId))
    .map((m) => ({ command: m.command, icon: iconOf.get(m.command) ?? "" }))
    .filter((x) => x.icon !== "");
}

describe("иконки в заголовках панелей", () => {
  it("в панели «Воркспейсы» нет двух кнопок с одной иконкой", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const { command, icon } of titleIcons("vscodesync.workspaces")) {
      const prev = seen.get(icon);
      if (prev !== undefined) {
        dupes.push(`${icon}: ${prev} ↔ ${command}`);
      }
      seen.set(icon, command);
    }
    expect(dupes).toEqual([]);
  });

  it("фильтр воркспейсов и режим «только расхождения» — разные иконки", () => {
    expect(iconOf.get("vscodesync.filterWorkspaces")).toBe("$(filter)");
    expect(iconOf.get("vscodesync.toggleTreeOnlyDiverged")).toBe("$(diff)");
  });

  it("каждая кнопка заголовка вообще имеет иконку или уходит в меню «…»", () => {
    // Пункт без иконки VS Code прячет в overflow — это законно, но он не
    // должен при этом претендовать на место в navigation-группе.
    const navWithoutIcon = (pkg.contributes.menus["view/title"] ?? [])
      .filter((m) => (m.when ?? "").includes("vscodesync.workspaces"))
      .filter((m) => (m.group ?? "").startsWith("navigation"))
      .filter((m) => (iconOf.get(m.command) ?? "") === "")
      .map((m) => m.command);
    expect(navWithoutIcon).toEqual([]);
  });
});
