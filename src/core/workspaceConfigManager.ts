/**
 * Public façade over `.vscode/vscodesync.json`.
 *
 * Every read and write in the extension goes through here, and every one of
 * them is now served by the single per-root owner in `workspaceConfigStore`:
 * reads come from one in-memory copy, writes run on a serialised queue.
 *
 * Before that, each of the ~15 call sites did its own open read-modify-write
 * against the file. With `sync.workspaceConcurrency` defaulting to 2 the steps
 * interleaved and the later write silently discarded whatever the earlier one
 * had recorded — statuses, etags, `lastSync`, tracked files.
 *
 * The façade is deliberately kept: routing 15 call sites through a new API
 * would have left the old one available, and the next call site added would
 * have reached for it.
 */
import type { WorkspaceConfig } from "./types.js";
import { workspaceConfigPath } from "./workspaceConfigFile.js";
import { getWorkspaceConfigStore } from "./io/workspaceConfigStore.js";

export const WorkspaceConfigManager = {
  getConfigPath: workspaceConfigPath,

  load(workspaceRoot: string): Promise<WorkspaceConfig> {
    return getWorkspaceConfigStore(workspaceRoot).load();
  },

  save(config: WorkspaceConfig, workspaceRoot: string): Promise<void> {
    return getWorkspaceConfigStore(workspaceRoot).save(config);
  },

  /**
   * Serialised read-modify-write. Prefer this over `load` + mutate + `save`:
   * only this form is atomic against a concurrent workspace branch.
   */
  mutate<T>(
    workspaceRoot: string,
    fn: (config: WorkspaceConfig) => Promise<T> | T,
  ): Promise<T> {
    return getWorkspaceConfigStore(workspaceRoot).mutate(fn);
  },

  /** Drop the in-memory copy — next `load` re-reads from disk. */
  invalidate(workspaceRoot: string): void {
    getWorkspaceConfigStore(workspaceRoot).invalidate();
  },
};
