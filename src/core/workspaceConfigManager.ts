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

function getConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, REL_PATH);
}

export const WorkspaceConfigManager = {
  getConfigPath,

  async load(workspaceRoot: string): Promise<WorkspaceConfig> {
    const filePath = getConfigPath(workspaceRoot);
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
  },

  async save(config: WorkspaceConfig, workspaceRoot: string): Promise<void> {
    const filePath = getConfigPath(workspaceRoot);
    const body = `${JSON.stringify(config, null, 2)}\n`;
    await writeTextFileAtomic(filePath, body);
  },
};
