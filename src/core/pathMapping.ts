import * as path from "node:path";
import type { WorkspaceConfig } from "./types.js";
import { toPosixPath } from "../utils/paths.js";

/** Invalid `pathMapping` or path escapes VS Code workspace folder. */
export class PathMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathMappingError";
  }
}

/** Parent directory must contain child (resolved paths). Same volume edge cases handled by path.relative. */
export function isDirectoryInsideOrSameWorkspace(parentWorkspaceRoot: string, candidateAbsolute: string): boolean {
  const p = path.resolve(parentWorkspaceRoot);
  const c = path.resolve(candidateAbsolute);
  const rel = path.relative(p, c);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Root directory for synced files on this machine: `pathMapping[machineName]` or workspace folder.
 * Validates mapping points inside workspace folder when set.
 */
export function resolveEffectiveSyncRoot(
  workspaceRoot: string,
  pathMapping: Record<string, string> | undefined,
  machineName: string,
): { effectiveRoot: string } {
  const ws = path.resolve(workspaceRoot);
  const key = machineName.trim();
  const mappedRaw = key !== "" ? pathMapping?.[key]?.trim() : undefined;
  if (!mappedRaw) {
    return { effectiveRoot: ws };
  }
  const mapped = path.resolve(mappedRaw);
  if (!isDirectoryInsideOrSameWorkspace(ws, mapped)) {
    throw new PathMappingError(
      `pathMapping для «${key}» должен указывать каталог внутри workspace (${ws}), получено: ${mapped}`,
    );
  }
  return { effectiveRoot: mapped };
}

/** Manifest/local tracked posix path → absolute file path; ensures result stays inside workspace folder. */
export function trackedLocalAbsolutePath(
  workspaceRoot: string,
  pathMapping: Record<string, string> | undefined,
  machineName: string,
  posixRel: string,
): string {
  const { effectiveRoot } = resolveEffectiveSyncRoot(workspaceRoot, pathMapping, machineName);
  const segments = posixRel.replace(/\\/g, "/").split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new PathMappingError(`Недопустимый относительный путь: ${posixRel}`);
  }
  const abs = path.join(effectiveRoot, ...segments);
  const ws = path.resolve(workspaceRoot);
  if (!isDirectoryInsideOrSameWorkspace(ws, abs)) {
    throw new PathMappingError(`Путь вне workspace: ${abs}`);
  }
  return abs;
}

/** Absolute file path → posix path relative to effective sync root (same as manifest `localPath`). */
export function absoluteToTrackedPosix(
  workspaceRoot: string,
  pathMapping: Record<string, string> | undefined,
  machineName: string,
  absoluteFsPath: string,
): string {
  const { effectiveRoot } = resolveEffectiveSyncRoot(workspaceRoot, pathMapping, machineName);
  const abs = path.resolve(absoluteFsPath);
  const rel = path.relative(effectiveRoot, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathMappingError(`Файл вне корня синхронизации (${effectiveRoot}): ${absoluteFsPath}`);
  }
  return toPosixPath(rel);
}

/** Snapshot helpers — cfg already loaded; machine name must match global config on this machine. */
export function trackedRootFromWorkspaceConfig(workspaceRoot: string, cfg: WorkspaceConfig, machineName: string): string {
  return resolveEffectiveSyncRoot(workspaceRoot, cfg.pathMapping, machineName).effectiveRoot;
}
