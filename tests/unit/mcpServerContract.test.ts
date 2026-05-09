import { describe, it, expect } from "vitest";
import {
  McpNotImplementedError,
  makeSkeletonMcpHandlers,
} from "../../src/core/mcpServerContract.js";

describe("MCP server contract skeleton", () => {
  it("every handler throws McpNotImplementedError", async () => {
    const h = makeSkeletonMcpHandlers();
    await expect(h.listWorkspaces({})).rejects.toBeInstanceOf(McpNotImplementedError);
    await expect(h.pushFile({ workspaceId: "x", relPath: "y" })).rejects.toBeInstanceOf(McpNotImplementedError);
    await expect(h.queryHistory({})).rejects.toBeInstanceOf(McpNotImplementedError);
    await expect(h.listConflicts({})).rejects.toBeInstanceOf(McpNotImplementedError);
    await expect(h.resolveConflict({ workspaceId: "x", relPath: "y", strategy: "keep_mine" }))
      .rejects.toBeInstanceOf(McpNotImplementedError);
  });

  it("error has the canonical code field", () => {
    const e = new McpNotImplementedError();
    expect(e.code).toBe("mcp_not_implemented");
    expect(e.name).toBe("McpNotImplementedError");
  });
});
