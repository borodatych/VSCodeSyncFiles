/**
 * Workspace Templates — skeleton.
 *
 * Goal: a curated catalog of "starter workspaces" (e.g. "Node TS app",
 * "Python data project") the user can clone in one click. The pure helper
 * validates a template manifest; the actual install (clone + register +
 * track files) throws a sentinel.
 */

export class WorkspaceTemplatesNotImplementedError extends Error {
  constructor(message = "Workspace template installer is not implemented yet") {
    super(message);
    this.name = "WorkspaceTemplatesNotImplementedError";
  }
}

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

export function installTemplate(_t: WorkspaceTemplate, _targetFolder: string): never {
  throw new WorkspaceTemplatesNotImplementedError();
}
