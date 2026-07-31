/**
 * Structural guard for the «Расхождения» webview (stage 3.5).
 *
 * The panel imports `vscode`, so its HTML cannot be built inside a unit test.
 * What can be checked — and is worth checking, because breaking it is silent —
 * is the source itself: that the page keeps its nonce-based CSP, that it never
 * grows a `executeCommand`-from-the-page hole, and that the key formula the
 * script recomputes stays tied to the exported separator instead of drifting
 * into a hand-typed one. The last of those already went wrong once: the core
 * used a raw NUL while the page used a space, so no checkbox would ever have
 * matched a row.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const PANEL = join(ROOT, "src", "ui", "divergencePanel.ts");
const raw = readFileSync(PANEL, "utf8");

/**
 * Source with comments blanked out. The header of this very file quotes
 * `executeCommand(msg.command, …)` as the pattern it forbids — a gate that
 * fires on its own documentation teaches people to delete the documentation.
 */
const source = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

/** The HTML template literal inside `buildHtml`. */
function template(): string {
  const start = raw.indexOf("<!DOCTYPE html>");
  const end = raw.indexOf("</html>`", start);
  expect(start, "template start").toBeGreaterThan(-1);
  expect(end, "template end").toBeGreaterThan(-1);
  return raw.slice(start, end + "</html>".length);
}

describe("divergencePanel — безопасность страницы", () => {
  it("не выполняет команду по имени из вебвью", () => {
    // The hole present in commandCenter.ts and settingsPanel.ts.
    expect(source).not.toMatch(/executeCommand\s*\(\s*(msg|message|m)\./);
    expect(template()).not.toContain("executeCommand");
  });

  it("страница объявляет CSP с nonce и запрещает всё по умолчанию", () => {
    const html = template();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-${nonce}'");
    expect(html).toMatch(/<script nonce="\$\{nonce\}">/);
  });

  it("в шаблоне нет внешних ресурсов", () => {
    const html = template();
    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
  });

  it("входящие сообщения проходят через валидатор из ядра", () => {
    expect(source).toContain("parseDivergenceRequest");
    expect(source).toMatch(/if \(req === null\)/);
  });
});

describe("divergencePanel — целостность шаблона", () => {
  it("подстановки ограничены известным набором", () => {
    const html = template();
    const seen = new Set<string>();
    const re = /\$\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) seen.add(m[1]);
    expect([...seen].sort()).toEqual([
      "JSON.stringify(DIVERGENCE_KEY_SEP)",
      "cspSource",
      "escapeHtml(d.title)",
      "nonce",
    ]);
  });

  it("ключ строки в скрипте собирается из общего разделителя", () => {
    const html = template();
    expect(html).toContain("const SEP = ${JSON.stringify(DIVERGENCE_KEY_SEP)};");
    expect(html).toContain("[r.root, r.workspaceId, r.posixRel].join(SEP)");
    // A hand-typed separator is exactly the drift this guards against.
    expect(html).not.toMatch(/r\.root \+ ['"] ['"]/);
  });

  it("все элементы, которые ищет скрипт, есть в разметке", () => {
    const html = template();
    const ids = new Set<string>();
    const re = /getElementById\('([^']+)'\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) ids.add(m[1]);
    expect(ids.size).toBeGreaterThan(0);
    for (const id of ids) {
      expect(html, `id="${id}" отсутствует в разметке`).toContain(`id="${id}"`);
    }
  });

  it("каждый чип фильтра соответствует направлению из плана", () => {
    const html = template();
    const chips = [...html.matchAll(/class="chip" data-f="([^"]+)"/g)].map((m) => m[1]);
    expect(chips.sort()).toEqual(["all", "conflict", "pull", "push"]);
  });

  it("текст из данных экранируется, а не вставляется как есть", () => {
    const html = template();
    // Every interpolation of a row/group field inside innerHTML goes через esc().
    for (const field of ["r.posixRel", "g.workspaceNote", "r.reason", "r.editingByName"]) {
      const raw = new RegExp(`\\+\\s*${field.replace(".", "\\.")}\\s*\\+`);
      expect(html, `${field} вставляется без esc()`).not.toMatch(raw);
    }
    expect(html).toContain("esc(r.posixRel)");
    expect(html).toContain("esc(g.workspaceNote)");
  });
});
