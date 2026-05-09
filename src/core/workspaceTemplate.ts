/**
 * v2.20.5 — workspace template manifest shape + skeleton parser.
 *
 * A `.vscodesync-template.json` describes how a new workspace should be
 * bootstrapped: which file globs to track by default, which paths to
 * `.vscodesync-ignore`, recommended VS Code extensions, and an optional
 * post-create note shown in the welcome webview.
 *
 * The marketplace registry layer (fetch from a git-hosted index) is left
 * for a future iteration. This module ships the typed manifest, a strict
 * decoder, and a sentinel error for the install path.
 */

export interface WorkspaceTemplateManifest {
  schema: 1;
  /** Stable id, e.g. "vscodesync/typescript-monorepo". Lowercase, slashes ok. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** Short description. */
  description: string;
  /** Glob patterns that match files to track by default. */
  defaultFilesGlob: string[];
  /** `.vscodesync-ignore` patterns the template wants installed. */
  ignorePatterns: string[];
  /** Recommended VS Code extensions (publisher.name). */
  recommendedExtensions: string[];
  /** Markdown shown in the welcome webview after install. */
  welcomeMarkdown?: string;
  /** Tags for the registry search index. */
  tags?: string[];
  /** SemVer of the template itself; lets the marketplace surface updates. */
  version?: string;
}

export type ParseTemplateResult =
  | { ok: true; manifest: WorkspaceTemplateManifest }
  | { ok: false; reason: ParseTemplateRejection };

export type ParseTemplateRejection =
  | "bad_root"
  | "bad_schema"
  | "bad_id"
  | "bad_name"
  | "bad_description"
  | "bad_default_files_glob"
  | "bad_ignore_patterns"
  | "bad_recommended_extensions"
  | "bad_welcome_markdown"
  | "bad_tags"
  | "bad_version";

export function parseWorkspaceTemplate(raw: unknown): ParseTemplateResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "bad_root" };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema !== 1) return { ok: false, reason: "bad_schema" };
  if (typeof o.id !== "string" || o.id.length === 0) return { ok: false, reason: "bad_id" };
  if (typeof o.name !== "string" || o.name.length === 0) return { ok: false, reason: "bad_name" };
  if (typeof o.description !== "string") return { ok: false, reason: "bad_description" };
  const defaultFilesGlob = parseStringArray(o.defaultFilesGlob);
  if (!defaultFilesGlob) return { ok: false, reason: "bad_default_files_glob" };
  const ignorePatterns = parseStringArray(o.ignorePatterns);
  if (!ignorePatterns) return { ok: false, reason: "bad_ignore_patterns" };
  const recommendedExtensions = parseStringArray(o.recommendedExtensions);
  if (!recommendedExtensions) return { ok: false, reason: "bad_recommended_extensions" };
  const manifest: WorkspaceTemplateManifest = {
    schema: 1,
    id: o.id,
    name: o.name,
    description: o.description,
    defaultFilesGlob,
    ignorePatterns,
    recommendedExtensions,
  };
  if (o.welcomeMarkdown !== undefined) {
    if (typeof o.welcomeMarkdown !== "string") return { ok: false, reason: "bad_welcome_markdown" };
    manifest.welcomeMarkdown = o.welcomeMarkdown;
  }
  if (o.tags !== undefined) {
    const tags = parseStringArray(o.tags);
    if (!tags) return { ok: false, reason: "bad_tags" };
    manifest.tags = tags;
  }
  if (o.version !== undefined) {
    if (typeof o.version !== "string" || o.version.length === 0) {
      return { ok: false, reason: "bad_version" };
    }
    manifest.version = o.version;
  }
  return { ok: true, manifest };
}

function parseStringArray(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

export class TemplateMarketplaceNotImplementedError extends Error {
  readonly code = "template_marketplace_not_implemented" as const;
  constructor(message = "Workspace templates marketplace fetch is in skeleton mode (v2.20.5 in roadmap).") {
    super(message);
    this.name = "TemplateMarketplaceNotImplementedError";
  }
}
