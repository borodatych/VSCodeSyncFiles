/**
 * v2.20.1 — typed contract for the planned MCP (Model Context Protocol)
 * server endpoint. **Skeleton.** No `@modelcontextprotocol/sdk` import,
 * no transport layer — only the tool shape so the actual server can be
 * dropped in without touching the consumers.
 *
 * The contract mirrors what an MCP-aware AI agent (Claude Code, Cursor,
 * Continue, …) would call against a running VSCodeSync instance:
 *
 *   - `vscodesync.list_workspaces` — read-only enumeration of active
 *     workspaces.
 *   - `vscodesync.push_file` — explicit push of a single tracked file.
 *   - `vscodesync.query_history` — bounded fetch of activity events.
 *   - `vscodesync.list_conflicts` — current conflict set.
 *   - `vscodesync.resolve_conflict` — apply a resolution strategy.
 *
 * Any caller invoking the server before it ships throws
 * {@link McpNotImplementedError}, which the UI catches specifically and
 * routes to a "feature shipped in skeleton mode" hint.
 */

export class McpNotImplementedError extends Error {
  readonly code = "mcp_not_implemented" as const;
  constructor(message = "MCP server endpoint is in skeleton mode (v2.20.1 in roadmap).") {
    super(message);
    this.name = "McpNotImplementedError";
  }
}

export type McpToolName =
  | "vscodesync.list_workspaces"
  | "vscodesync.push_file"
  | "vscodesync.query_history"
  | "vscodesync.list_conflicts"
  | "vscodesync.resolve_conflict";

export interface McpListWorkspacesArgs {
  /** When true, include archived/suspended workspaces. Default false. */
  includeInactive?: boolean;
}

export interface McpListWorkspacesResult {
  workspaces: {
    id: string;
    note: string;
    provider: string;
    fileCount: number;
    lastSyncAtMs: number | null;
  }[];
}

export interface McpPushFileArgs {
  workspaceId: string;
  /** Workspace-relative POSIX path. */
  relPath: string;
}

export interface McpPushFileResult {
  ok: true;
  hash: string;
  pushedAtMs: number;
}

export interface McpQueryHistoryArgs {
  workspaceId?: string;
  /** Lower bound (inclusive). ms timestamp. */
  sinceMs?: number;
  /** Upper bound (exclusive). ms timestamp. */
  beforeMs?: number;
  /** Cap on rows returned. Default 100, max 1000. */
  limit?: number;
}

export interface McpQueryHistoryResult {
  events: {
    kind: string;
    workspaceId: string;
    machineId: string;
    relPath: string | null;
    atMs: number;
  }[];
  truncated: boolean;
}

export interface McpListConflictsArgs {
  workspaceId?: string;
}

export interface McpListConflictsResult {
  conflicts: {
    workspaceId: string;
    relPath: string;
    isBinary: boolean;
    detectedAtMs: number;
  }[];
}

export interface McpResolveConflictArgs {
  workspaceId: string;
  relPath: string;
  strategy: "keep_mine" | "take_theirs" | "ai_merge";
}

export interface McpResolveConflictResult {
  ok: true;
  strategy: McpResolveConflictArgs["strategy"];
  resolvedAtMs: number;
}

/** Top-level handler interface. Each method is a typed adapter; the real
 * implementation is wired by the future `src/mcp/server.ts` once the
 * `@modelcontextprotocol/sdk` package is present and the engine API
 * surface is bridged. */
export interface McpServerHandlers {
  listWorkspaces: (args: McpListWorkspacesArgs) => Promise<McpListWorkspacesResult>;
  pushFile: (args: McpPushFileArgs) => Promise<McpPushFileResult>;
  queryHistory: (args: McpQueryHistoryArgs) => Promise<McpQueryHistoryResult>;
  listConflicts: (args: McpListConflictsArgs) => Promise<McpListConflictsResult>;
  resolveConflict: (args: McpResolveConflictArgs) => Promise<McpResolveConflictResult>;
}

/** Sentinel handler set: every method throws the not-implemented error.
 * Useful as the default registration so callers see a clean error shape
 * instead of `undefined is not a function`. */
export function makeSkeletonMcpHandlers(): McpServerHandlers {
  const reject = (): Promise<never> =>
    Promise.reject(new McpNotImplementedError());
  return {
    listWorkspaces: reject,
    pushFile: reject,
    queryHistory: reject,
    listConflicts: reject,
    resolveConflict: reject,
  };
}
