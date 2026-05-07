/**
 * Workspace Templates — pure manifest validator + planner for the install.
 *
 * The actual file write happens in `src/ui/workspaceTemplatesCommand.ts`
 * which iterates `planTemplateInstall(template, targetFolder)` and writes
 * each entry through `writeTextFileAtomic`.
 */

export interface WorkspaceTemplate {
  id: string;
  title: string;
  description: string;
  tags: string[];
  files: { relPath: string; content: string }[];
}

export type ValidateResult =
  | { ok: true; value: WorkspaceTemplate }
  | { ok: false; reason: string };

export function validateWorkspaceTemplate(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const r = raw as Partial<WorkspaceTemplate>;
  if (typeof r.id !== "string" || r.id.length === 0) return { ok: false, reason: "id required" };
  if (typeof r.title !== "string" || r.title.length === 0) return { ok: false, reason: "title required" };
  if (typeof r.description !== "string") return { ok: false, reason: "description required" };
  if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string"))
    return { ok: false, reason: "tags must be string[]" };
  if (!Array.isArray(r.files)) return { ok: false, reason: "files required" };
  for (const f of r.files as unknown[]) {
    if (!f || typeof f !== "object") return { ok: false, reason: "file entry not object" };
    const file = f as { relPath?: unknown; content?: unknown };
    if (typeof file.relPath !== "string" || file.relPath.length === 0)
      return { ok: false, reason: "file.relPath required" };
    if (typeof file.content !== "string") return { ok: false, reason: "file.content required" };
    if (file.relPath.startsWith("/") || file.relPath.includes(".."))
      return { ok: false, reason: "file.relPath must not escape workspace" };
  }
  return { ok: true, value: r as WorkspaceTemplate };
}

export interface PlannedTemplateFile {
  /** Workspace-relative POSIX path. */
  relPath: string;
  /** Absolute target path, joined from `targetFolder + relPath` (POSIX). */
  absolutePath: string;
  content: string;
}

/**
 * Convert a validated template into a flat list of writes. Re-runs the
 * traversal-escape guard at install time as a defence in depth — a manifest
 * that passed validation could still mismatch what we expect after edits.
 */
export function planTemplateInstall(
  t: WorkspaceTemplate,
  targetFolder: string,
): PlannedTemplateFile[] {
  const folder = targetFolder.replace(/[/\\]+$/, "");
  if (!folder) {
    throw new Error("workspaceTemplates: targetFolder is empty");
  }
  return t.files.map((f) => {
    if (f.relPath.startsWith("/") || f.relPath.includes("..") || /^[A-Za-z]:[/\\]/.test(f.relPath)) {
      throw new Error(`workspaceTemplates: relPath escapes workspace: ${f.relPath}`);
    }
    const absolutePath = `${folder}/${f.relPath.replace(/^\/+/, "")}`;
    return { relPath: f.relPath, absolutePath, content: f.content };
  });
}

/** Built-in catalog of starter templates. */
export const BUILT_IN_TEMPLATES: WorkspaceTemplate[] = [
  {
    id: "vscodesync.notes",
    title: "Empty notes workspace",
    description: "Markdown notes + .vscodesync-ignore template",
    tags: ["notes", "markdown"],
    files: [
      {
        relPath: "README.md",
        content: "# Notes\n\nAdd your notes here. They'll sync via VSCodeSync.\n",
      },
      {
        relPath: ".vscodesync-ignore",
        content: "# Ignore patterns (gitignore syntax)\n.DS_Store\n*.tmp\n",
      },
    ],
  },
  {
    id: "vscodesync.snippets",
    title: "Code snippets workspace",
    description: "Per-language snippet stub + README",
    tags: ["snippets", "code"],
    files: [
      {
        relPath: "README.md",
        content: "# Snippets\n\nDrop your reusable code snippets here, organised per language.\n",
      },
      {
        relPath: "snippets/typescript.md",
        content: "# TypeScript snippets\n\n```ts\n// example\n```\n",
      },
      {
        relPath: "snippets/python.md",
        content: "# Python snippets\n\n```py\n# example\n```\n",
      },
    ],
  },
  {
    id: "vscodesync.docs",
    title: "Documentation project",
    description: "Roadmap + knowledge base scaffold",
    tags: ["docs", "knowledge"],
    files: [
      {
        relPath: "README.md",
        content: "# Documentation\n\n- See [roadmap.md](roadmap.md) for milestones.\n- See [knowledge.md](knowledge.md) for learned context.\n",
      },
      { relPath: "roadmap.md", content: "# Roadmap\n\n## Phase 1\n- [ ] First milestone\n" },
      { relPath: "knowledge.md", content: "# Knowledge\n\n_Insights worth remembering._\n" },
    ],
  },
];
