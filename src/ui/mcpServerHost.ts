/**
 * v2.20.1 — MCP server host stub backed by `@modelcontextprotocol/sdk`.
 *
 * Lazy-loads the SDK on first call so installs without the optional dep
 * boot cleanly. Exposes the `vscodesync.list_workspaces` tool against a
 * caller-supplied data source; all other tools from `mcpServerContract`
 * throw `McpNotImplementedError` until the engine adapter lands.
 *
 * Transport: stdio is the standard MCP transport, but VS Code extensions
 * run inside the editor process, not as a child. The `startMcpServer`
 * helper here exposes the server through an in-process callable — an MCP
 * client embedded in the editor (e.g. Continue's MCP integration) can
 * consume it directly. A dedicated stdio bridge (npm bin
 * `vscodesync-mcp`) is a follow-up.
 */
import { McpNotImplementedError } from "../core/mcpServerContract.js";
import { warnLog } from "../utils/log.js";

export interface McpWorkspaceProvider {
  listWorkspaces(includeInactive: boolean): Promise<{
    id: string;
    note: string;
    provider: string;
    fileCount: number;
    lastSyncAtMs: number | null;
  }[]>;
}

export interface McpServerHandle {
  /** Tear down the server. Idempotent. */
  dispose(): Promise<void>;
  /** True when the SDK loaded and the server is ready to accept calls. */
  isReady(): boolean;
}

interface McpSdkModule {
  Server: new (info: { name: string; version: string }, capabilities: { capabilities: { tools: Record<string, unknown> } }) => McpServerLike;
}

interface McpServerLike {
  setRequestHandler(schema: unknown, handler: (req: unknown) => Promise<unknown>): void;
  close(): Promise<void>;
}

let cachedSdk: McpSdkModule | null | undefined;

async function loadSdk(): Promise<McpSdkModule | null> {
  if (cachedSdk !== undefined) return cachedSdk;
  try {
    const dynamic = (specifier: string): Promise<unknown> => import(specifier);
    cachedSdk = (await dynamic("@modelcontextprotocol/sdk/server/index.js")) as McpSdkModule;
  } catch (e) {
    warnLog("mcp", `SDK not loadable: ${e instanceof Error ? e.message : String(e)}`);
    cachedSdk = null;
  }
  return cachedSdk;
}

export async function startMcpServer(provider: McpWorkspaceProvider): Promise<McpServerHandle> {
  const sdk = await loadSdk();
  if (!sdk) {
    return {
      isReady: () => false,
      dispose: () => Promise.resolve(),
    };
  }

  const server = new sdk.Server(
    { name: "vscodesync-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // SDK schemas are addressed by string id — using an opaque sentinel here
  // keeps the contract minimal until engine wiring lands.
  const TOOL_CALL_SCHEMA = { method: "tools/call" };
  server.setRequestHandler(TOOL_CALL_SCHEMA, async (req: unknown) => {
    const r = (req ?? {}) as { params?: { name?: string; arguments?: { includeInactive?: boolean } } };
    const name = r.params?.name;
    if (name === "vscodesync.list_workspaces") {
      const includeInactive = r.params?.arguments?.includeInactive === true;
      const list = await provider.listWorkspaces(includeInactive);
      return { content: [{ type: "text", text: JSON.stringify({ workspaces: list }, null, 2) }] };
    }
    throw new McpNotImplementedError(`Tool ${String(name)} not yet wired`);
  });

  return {
    isReady: () => true,
    dispose: () => server.close(),
  };
}
