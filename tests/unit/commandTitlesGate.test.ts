/**
 * Command titles: the product name belongs in `category`, not in every title.
 *
 * VS Code prints "<category>: <title>" in the palette by itself, and shows the
 * bare title in context menus. Baking the prefix into titles made menu rows
 * read "VSCodeSync: VSCodeSync: …"-long and, worse, drifted: newer commands
 * were added without it and became unfindable in the palette. This gate keeps
 * both halves honest.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  contributes: { commands: { command: string; title: string; category?: string }[] };
};
const nlsFiles = ["package.nls.json", "package.nls.en.json"] as const;

describe("вклад команд", () => {
  it("у каждой команды есть category «VibeSync»", () => {
    const missing = pkg.contributes.commands
      .filter((c) => c.category !== "VibeSync")
      .map((c) => c.command);
    expect(missing).toEqual([]);
  });

  it("ни один заголовок не начинается с имени продукта", () => {
    for (const file of nlsFiles) {
      const nls = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string>;
      const offenders = Object.entries(nls)
        .filter(([k]) => k.startsWith("cmd.") && k.endsWith(".title"))
        .filter(([, v]) => /^(VSCodeSync|VibeSync)\s*:/i.test(v))
        .map(([k]) => `${file}:${k}`);
      expect(offenders).toEqual([]);
    }
  });

  it("каждый заголовок команды переведён в обоих каталогах", () => {
    const keys = pkg.contributes.commands
      .map((c) => c.title)
      .filter((t) => t.startsWith("%"))
      .map((t) => t.slice(1, -1));
    for (const file of nlsFiles) {
      const nls = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, string | undefined>;
      const missing = keys.filter((k) => nls[k] === undefined);
      expect(missing, file).toEqual([]);
    }
  });
});
