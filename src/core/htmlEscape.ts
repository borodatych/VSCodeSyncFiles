/**
 * Pure HTML/attribute-escape utilities for the webview-rendering modules.
 *
 * No `vscode` import. Identical char set to OWASP recommendations: replace
 * & < > " ' so the resulting string is safe to drop both into element bodies
 * and into double-quoted attribute values.
 */

const HTML_ESCAPES: Partial<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const HTML_ESCAPE_RE = /[&<>"']/g;

/** Escape a string for safe inclusion in HTML element body OR a double-quoted
 * attribute value. Single-quoted attributes are also covered because we
 * escape `'`. Accepts string / number / boolean / null / undefined; other
 * types are coerced to empty string for safety. */
export function escapeHtml(input: string | number | boolean | null | undefined): string {
  if (input === null || input === undefined) return "";
  const s = typeof input === "string" ? input : String(input);
  return s.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Convenience for class-name lists where the caller may pass undefined. */
export function joinClasses(...classes: (string | false | null | undefined)[]): string {
  return classes.filter((c): c is string => typeof c === "string" && c.length > 0).join(" ");
}
