/**
 * Cross-cutting — pure validator for the `%key%` placeholder ↔
 * `package.nls.json` / `package.nls.ru.json` cross-reference. Caller
 * (existing tests / the i18n CI script) reads the three JSON files,
 * extracts string values, and feeds them in here.
 *
 * No `vscode` import. No fs access — caller does the I/O.
 */

const PLACEHOLDER_RE = /^%([a-zA-Z0-9._-]+)%$/;

export interface I18nConsistencyInput {
  /** Set of `%key%` placeholder names extracted from package.json strings. */
  referencedKeys: ReadonlySet<string>;
  /** Map of key → translation present in package.nls.json (default locale,
   * usually English). */
  nlsDefault: ReadonlyMap<string, string>;
  /** Map of key → translation present in a non-default locale (e.g. ru). */
  nlsLocale: ReadonlyMap<string, string>;
  /** Locale identifier for the second map (used in the report only). */
  localeName: string;
}

export interface I18nConsistencyIssue {
  kind: I18nConsistencyIssueKind;
  key: string;
  detail: string;
}

export type I18nConsistencyIssueKind =
  | "missing_in_default"
  | "missing_in_locale"
  | "unused_in_default"
  | "unused_in_locale"
  | "empty_translation";

export interface I18nConsistencyReport {
  totalReferenced: number;
  defaultCoverage: number;
  localeCoverage: number;
  issueCount: number;
  issues: I18nConsistencyIssue[];
}

export function validateI18nConsistency(
  input: I18nConsistencyInput,
): I18nConsistencyReport {
  const issues: I18nConsistencyIssue[] = [];
  const refs = input.referencedKeys;
  const defKeys = new Set(input.nlsDefault.keys());
  const locKeys = new Set(input.nlsLocale.keys());

  let defCovered = 0;
  let locCovered = 0;

  for (const key of refs) {
    if (!defKeys.has(key)) {
      issues.push({
        kind: "missing_in_default",
        key,
        detail: `package.json references %${key}% but package.nls.json has no entry.`,
      });
    } else {
      defCovered += 1;
      const v = input.nlsDefault.get(key);
      if (v?.trim().length === 0) {
        issues.push({
          kind: "empty_translation",
          key,
          detail: `package.nls.json has an empty translation for %${key}%.`,
        });
      }
    }
    if (!locKeys.has(key)) {
      issues.push({
        kind: "missing_in_locale",
        key,
        detail: `package.json references %${key}% but package.nls.${input.localeName}.json has no entry.`,
      });
    } else {
      locCovered += 1;
      const v = input.nlsLocale.get(key);
      if (v?.trim().length === 0) {
        issues.push({
          kind: "empty_translation",
          key,
          detail: `package.nls.${input.localeName}.json has an empty translation for %${key}%.`,
        });
      }
    }
  }

  for (const key of defKeys) {
    if (!refs.has(key)) {
      issues.push({
        kind: "unused_in_default",
        key,
        detail: `package.nls.json defines %${key}% but no package.json string references it.`,
      });
    }
  }
  for (const key of locKeys) {
    if (!refs.has(key)) {
      issues.push({
        kind: "unused_in_locale",
        key,
        detail: `package.nls.${input.localeName}.json defines %${key}% but no package.json string references it.`,
      });
    }
  }

  const total = refs.size;
  return {
    totalReferenced: total,
    defaultCoverage: total === 0 ? 1 : defCovered / total,
    localeCoverage: total === 0 ? 1 : locCovered / total,
    issueCount: issues.length,
    issues,
  };
}

/** Walk every string value inside a JSON-like structure and emit any
 * exact `%key%` placeholder names. Values that are not whole-string
 * placeholders are ignored — VS Code does not interpolate substrings. */
export function extractI18nKeyReferences(root: unknown): Set<string> {
  const out = new Set<string>();
  walk(root, out);
  return out;
}

function walk(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    const m = PLACEHOLDER_RE.exec(node);
    if (m) out.add(m[1]);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const v of Object.values(node)) walk(v, out);
  }
}
