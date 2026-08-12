/**
 * Consistency gates between `package.json` → `contributes.configuration`, the
 * source that reads those settings, the localisation bundles and README.
 *
 * All four drifted apart before 1.0.0: README promised seven defaults the schema
 * did not have (`gitBranchAutoSync` was documented as `false` while shipping
 * `true`), `tombstonePurgeDays` was read by the engine factory and quoted in a
 * user-facing warning without ever being declared, and sixteen declared settings
 * are not read anywhere — a user can toggle them and nothing happens.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_SECTION } from "../../src/core/extensionIdentity.js";

const ROOT = join(__dirname, "..", "..");

interface ConfigProperty {
  type?: string;
  default?: unknown;
  description?: string;
  markdownDescription?: string;
}
interface PackageJson {
  contributes?: { configuration?: { properties?: Record<string, ConfigProperty> } };
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function readNlsBundle(rel: string): Record<string, string> {
  return readJson(rel) as Record<string, string>;
}

function configProperties(): Record<string, ConfigProperty> {
  const pkg = readJson("package.json") as PackageJson;
  return pkg.contributes?.configuration?.properties ?? {};
}

/** Render a schema default the way the README table writes it. */
function formatDefault(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

/**
 * Short keys the code actually reads, writes or watches through the workspace
 * configuration API. A bare string match is not enough: the settings webview
 * lists every key as a plain literal, which would make dead settings look wired.
 */
function configReads(sources: string[]): Set<string> {
  const patterns = [
    /\.get\s*<[^>]*>\s*\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g,
    /\.get\s*\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g,
    /\.update\s*\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g,
    /affectsConfiguration\s*\(\s*["'`]([A-Za-z0-9_.]+)["'`]/g,
  ];
  // Keys named through a module constant rather than spelled inline. Without
  // this the gate reads "not wired" as soon as a call site follows the
  // no-hardcode rule, which is the wrong lesson to teach. Anchored on
  // `getConfiguration` so that `globalState.get(KEY)` and `secrets.get(KEY)`,
  // which are not settings at all, do not resolve into phantom keys.
  const viaConst = [
    /getConfiguration\s*\([^)]*\)\s*\.get\s*(?:<[^>]*>)?\s*\(\s*([A-Z][A-Z0-9_]*)\b/g,
  ];
  const out = new Set<string>();
  for (const txt of sources) {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        out.add(m[1].replace(new RegExp(`^${CONFIG_SECTION}\\.`), ""));
      }
    }
    for (const re of viaConst) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        const decl = new RegExp(`const\\s+${m[1]}\\s*=\\s*["'\`]([A-Za-z0-9_.]+)["'\`]`).exec(txt);
        if (decl) out.add(decl[1].replace(new RegExp(`^${CONFIG_SECTION}\\.`), ""));
      }
    }
  }
  return out;
}

/**
 * Settings that exist in the schema but are read by no source file. Each entry
 * is a promise the product does not keep, so the list is spelled out rather than
 * skipped: the gate fails as soon as a new one appears. Removing or wiring these
 * is scheduled work — see `.cursor/plans/stabilization100.plan.md`, sections B
 * (policy rework) and E (provider parity).
 */
const UNWIRED: Record<string, string> = {
  "vscodesync.autoPause.learnedSchedule.enabled": "обучаемое расписание не реализовано — этап 3",
  "vscodesync.ai.sessionSummary.enabled": "флаг AI-сводки не читается — этап 6",
  "vscodesync.ai.suggestWorkspaceTags.enabled": "флаг AI-тегов не читается — этап 6",
  "vscodesync.ai.pathMapper.enabled": "флаг AI path mapper не читается — этап 6",
  "vscodesync.historyLazyDrainMinutes": "отложенный drain истории не подключён — этап 1",
  "vscodesync.tokenRefreshSkewMinutes": "запас на обновление токена не подключён — этап 4 (E4)",
  "vscodesync.onedrive.uploadSessionThresholdMB": "чанковая заливка OneDrive не подключена — этап 4 (E6)",
  "vscodesync.onedrive.uploadChunkMB": "чанковая заливка OneDrive не подключена — этап 4 (E6)",
  "vscodesync.yandex.apiTimeoutMs": "таймауты Яндекса не подключены — этап 4",
  "vscodesync.yandex.dataTimeoutMs": "таймауты Яндекса не подключены — этап 4",
  "vscodesync.yandex.lockedRetryDelayMs": "ретрай при locked не подключён — этап 4",
};

describe("contributes.configuration ↔ src", () => {
  const props = configProperties();
  const sources = sourceFiles().map((f) => readFileSync(f, "utf8"));
  const reads = configReads(sources);
  // `vscodesync.a.b` may be read either whole or as section `a` + key `b`.
  const isRead = (key: string): boolean => {
    const short = key.slice(CONFIG_SECTION.length + 1);
    if (reads.has(short)) return true;
    const tail = short.slice(short.lastIndexOf(".") + 1);
    const head = short.slice(0, short.lastIndexOf("."));
    return head.length > 0 && reads.has(head) && reads.has(tail);
  };

  it("каждая объявленная настройка либо читается кодом, либо числится в UNWIRED", () => {
    const unread = Object.keys(props).filter((k) => !isRead(k) && !(k in UNWIRED));
    expect(unread).toEqual([]);
  });

  it("UNWIRED не содержит настроек, которые уже подключены", () => {
    const stale = Object.keys(UNWIRED).filter((k) => isRead(k));
    expect(stale).toEqual([]);
  });

  it("UNWIRED не содержит настроек, которых больше нет в схеме", () => {
    const ghosts = Object.keys(UNWIRED).filter((k) => !(k in props));
    expect(ghosts).toEqual([]);
  });

  it("каждый affectsConfiguration(\"vscodesync.…\") ссылается на существующую настройку или её секцию", () => {
    const declared = Object.keys(props);
    const bad: string[] = [];
    const re = /affectsConfiguration\s*\(\s*["']([A-Za-z0-9_.]+)["']/g;
    for (const txt of sources) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(txt)) !== null) {
        const key = m[1];
        if (!key.startsWith(`${CONFIG_SECTION}.`)) continue;
        const hit = declared.some((d) => d === key || d.startsWith(`${key}.`));
        if (!hit) bad.push(key);
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

describe("contributes.configuration ↔ localisation", () => {
  it("каждый %ключ% описания есть в обоих nls-бандлах", () => {
    const props = configProperties();
    const base = readNlsBundle("package.nls.json");
    const en = readNlsBundle("package.nls.en.json");
    const missing: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
      const raw = prop.description ?? prop.markdownDescription;
      if (typeof raw !== "string" || !raw.startsWith("%")) continue;
      const nlsKey = raw.slice(1, -1);
      if (!(nlsKey in base)) missing.push(`${key} → отсутствует в package.nls.json (${nlsKey})`);
      if (!(nlsKey in en)) missing.push(`${key} → отсутствует в package.nls.en.json (${nlsKey})`);
    }
    expect(missing).toEqual([]);
  });

  it("оба nls-бандла содержат один и тот же набор ключей", () => {
    const base = Object.keys(readNlsBundle("package.nls.json"));
    const en = Object.keys(readNlsBundle("package.nls.en.json"));
    expect(base.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !base.includes(k))).toEqual([]);
  });
});

describe("README ↔ contributes.configuration", () => {
  const props = configProperties();
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");

  interface Row {
    key: string;
    documented: string;
  }
  function tableRows(): Row[] {
    const rows: Row[] = [];
    const re = /^\|\s*`(vscodesync\.[A-Za-z0-9_.]+)`\s*\|\s*([^|]*?)\s*\|/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(readme)) !== null) {
      rows.push({ key: m[1], documented: m[2].replace(/`/g, "").trim() });
    }
    return rows;
  }

  it("таблица настроек в README распознаётся", () => {
    expect(tableRows().length).toBeGreaterThan(10);
  });

  it("README не описывает несуществующих настроек", () => {
    const unknown = tableRows()
      .map((r) => r.key)
      .filter((k) => !(k in props));
    expect(unknown).toEqual([]);
  });

  it("дефолт в README совпадает со схемой", () => {
    const mismatches: string[] = [];
    for (const row of tableRows()) {
      const prop = props[row.key] as ConfigProperty | undefined;
      if (!prop) continue;
      // "—" means the row deliberately documents no scalar default (objects).
      if (row.documented === "—") continue;
      const actual = formatDefault(prop.default);
      if (row.documented !== actual) {
        mismatches.push(`${row.key}: README=${row.documented} схема=${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
