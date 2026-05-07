import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ActiveWorkspaceEntry, WorkspaceConfig } from "../core/types.js";
import { buildCombinedIgnoreRules, trackedPosixRelForIgnore } from "../core/workspaceIgnoreRules.js";
import { isIgnoredByRules } from "./ignoreMatch.js";

export interface CollectFilesToAddOptions {
  entry?: ActiveWorkspaceEntry;
  cfg?: WorkspaceConfig;
  machineName?: string;
}

function isInsideWorkspaceDir(workspaceRoot: string, candidate: string): boolean {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(candidate);
  const rel = path.relative(root, abs);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Collect ordinary file paths under given roots (files or directories), applying
 * the same combined ignore rules as add-file guards. Ignored paths are omitted.
 */
export async function collectFilesToAddUnderRoots(
  workspaceRoot: string,
  roots: string[],
  opts: CollectFilesToAddOptions,
): Promise<string[]> {
  const rules = await buildCombinedIgnoreRules(workspaceRoot, opts.entry);
  const seen = new Set<string>();
  const result: string[] = [];

  const maybeAddFile = (abs: string): void => {
    if (!isInsideWorkspaceDir(workspaceRoot, abs)) {
      return;
    }
    const posixRel = trackedPosixRelForIgnore(workspaceRoot, abs, opts.cfg, opts.machineName);
    if (isIgnoredByRules(posixRel, rules)) {
      return;
    }
    const norm = path.normalize(abs);
    if (seen.has(norm)) {
      return;
    }
    seen.add(norm);
    result.push(abs);
  };

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        maybeAddFile(full);
      } else if (ent.isSymbolicLink()) {
        try {
          const st = await fs.stat(full);
          if (st.isDirectory()) {
            await walk(full);
          } else if (st.isFile()) {
            maybeAddFile(full);
          }
        } catch {
          /* broken symlink */
        }
      }
    }
  };

  for (const root of roots) {
    const absRoot = path.resolve(root);
    if (!isInsideWorkspaceDir(workspaceRoot, absRoot)) {
      continue;
    }
    let st;
    try {
      st = await fs.lstat(absRoot);
    } catch {
      continue;
    }
    if (st.isFile()) {
      maybeAddFile(absRoot);
    } else if (st.isDirectory()) {
      await walk(absRoot);
    } else if (st.isSymbolicLink()) {
      try {
        const stFollow = await fs.stat(absRoot);
        if (stFollow.isDirectory()) {
          await walk(absRoot);
        } else if (stFollow.isFile()) {
          maybeAddFile(absRoot);
        }
      } catch {
        /* broken */
      }
    }
  }

  result.sort();
  return result;
}
