/**
 * Raw disk access for `.vscode/vscodesync.json`. No caching, no serialisation.
 *
 * Split out of `workspaceConfigManager` so that the single owner
 * (`workspaceConfigStore`) can sit between every caller and the file without a
 * circular import. Nothing outside the store should reach for these directly.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceConfig } from "./types.js";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";

const REL_PATH = path.join(".vscode", "vscodesync.json");

function sanitizePathMapping(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const kk = k.trim();
    if (!kk || typeof v !== "string") {
      continue;
    }
    const vv = v.trim();
    if (vv.length > 0) {
      out[kk] = vv;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function defaultWorkspaceConfig(): WorkspaceConfig {
  return { activeWorkspaces: [], files: [] };
}

export function workspaceConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, REL_PATH);
}

/** Identity of the file as it was last seen — cheap staleness check. */
export interface WorkspaceConfigStamp {
  mtimeMs: number;
  size: number;
}

/** `undefined` when the file does not exist. One `stat`, no read. */
export async function statWorkspaceConfig(
  workspaceRoot: string,
): Promise<WorkspaceConfigStamp | undefined> {
  try {
    const st = await fs.stat(workspaceConfigPath(workspaceRoot));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return undefined;
  }
}

export function sameStamp(
  a: WorkspaceConfigStamp | undefined,
  b: WorkspaceConfigStamp | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export async function readWorkspaceConfigFromDisk(workspaceRoot: string): Promise<WorkspaceConfig> {
  const filePath = workspaceConfigPath(workspaceRoot);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Partial<WorkspaceConfig>;
    return {
      activeWorkspaces: data.activeWorkspaces ?? [],
      files: data.files ?? [],
      pathMapping: sanitizePathMapping(data.pathMapping),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
    return defaultWorkspaceConfig();
  }
}

export async function writeWorkspaceConfigToDisk(
  config: WorkspaceConfig,
  workspaceRoot: string,
): Promise<void> {
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await writeTextFileAtomic(workspaceConfigPath(workspaceRoot), body);
}
