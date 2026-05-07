import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ActiveWorkspaceEntry, WorkspaceConfig } from "./types.js";
import { absoluteToTrackedPosix } from "./pathMapping.js";
import { parseIgnoreRules } from "../utils/ignoreMatch.js";

async function readVscodesyncIgnore(workspaceRoot: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceRoot, ".vscodesync-ignore"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Priority: `.vscodesync-ignore` → manifest `sharedIgnorePatterns` → local `ignorePatterns`.
 * Combined as one gitignore-style rule list (order preserved).
 */
export async function buildCombinedIgnoreRules(
  workspaceRoot: string,
  entry: ActiveWorkspaceEntry | undefined,
): Promise<ReturnType<typeof parseIgnoreRules>> {
  const fileRaw = await readVscodesyncIgnore(workspaceRoot);
  const blocks: string[] = [];
  if (fileRaw) {
    blocks.push(fileRaw);
  }
  const shared = entry?.sharedIgnorePatterns?.join("\n") ?? "";
  if (shared.trim().length > 0) {
    blocks.push(shared);
  }
  const local = entry?.ignorePatterns?.join("\n") ?? "";
  if (local.trim().length > 0) {
    blocks.push(local);
  }
  return parseIgnoreRules(blocks.join("\n\n"));
}

/** Tracked POSIX path for gitignore-style rules (.vscodesync-ignore, shared, local). */
export function trackedPosixRelForIgnore(
  workspaceRoot: string,
  fsPath: string,
  cfg: WorkspaceConfig | undefined,
  machineName: string | undefined,
): string {
  const mn = machineName?.trim() ?? "";
  if (cfg !== undefined && mn !== "") {
    try {
      return absoluteToTrackedPosix(workspaceRoot, cfg.pathMapping, mn, fsPath);
    } catch {
      /* same as explorer relative path fallback */
    }
  }
  return path.relative(workspaceRoot, fsPath).split(path.sep).join("/");
}
