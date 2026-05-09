/**
 * v2.20.2 — DuckDB virtual-tables planner + SCTP runtime skeleton +
 * workspace.fs.prefetch adapter.
 */
import { describe, expect, it } from "vitest";
import {
  DuckDbHostNotAvailableError,
  planVirtualTableMount,
} from "../../src/core/duckdbVirtualTables.js";
import {
  SctpRuntimeNotImplementedError,
  makeSkeletonSctpRuntime,
} from "../../src/core/sctpRuntimeHook.js";
import { tryPrefetchUris } from "../../src/ui/workspaceFsPrefetchAdapter.js";

describe("planVirtualTableMount", () => {
  it("returns empty plan for no sources", () => {
    const p = planVirtualTableMount([]);
    expect(p.setupStatements).toEqual([]);
    expect(p.mountStatements).toEqual([]);
    expect(p.virtualFiles).toEqual([]);
  });

  it("emits INSTALL+LOAD json + one CREATE VIEW per source", () => {
    const p = planVirtualTableMount([
      { tableName: "activity", virtualFilePath: "activity.json", sizeBytes: 1024 },
      { tableName: "stats", virtualFilePath: "stats.json", sizeBytes: 512 },
    ]);
    expect(p.setupStatements).toEqual(["INSTALL json;", "LOAD json;"]);
    expect(p.mountStatements).toHaveLength(2);
    expect(p.mountStatements[0]).toContain("CREATE OR REPLACE VIEW activity AS SELECT * FROM read_json_auto('activity.json'");
    expect(p.virtualFiles).toEqual(["activity.json", "stats.json"]);
  });

  it("rejects invalid SQL identifiers", () => {
    expect(() =>
      planVirtualTableMount([{ tableName: "1bad", virtualFilePath: "x.json", sizeBytes: 1 }]),
    ).toThrow();
    expect(() =>
      planVirtualTableMount([{ tableName: "drop table", virtualFilePath: "x.json", sizeBytes: 1 }]),
    ).toThrow();
  });

  it("DuckDbHostNotAvailableError carries code", () => {
    const e = new DuckDbHostNotAvailableError();
    expect(e.code).toBe("duckdb_host_not_available");
  });
});

describe("makeSkeletonSctpRuntime", () => {
  it("rejects send with SctpRuntimeNotImplementedError", async () => {
    const rt = makeSkeletonSctpRuntime(4);
    expect(rt.lanes).toBe(4);
    await expect(rt.send({ kind: "manifest", payload: new Uint8Array() })).rejects.toBeInstanceOf(
      SctpRuntimeNotImplementedError,
    );
  });
  it("onFrame returns a no-op unsubscribe", () => {
    const rt = makeSkeletonSctpRuntime(2);
    const off = rt.onFrame(() => { /* no-op */ });
    expect(typeof off).toBe("function");
    expect(() => { off(); }).not.toThrow();
  });
});

describe("tryPrefetchUris", () => {
  it("returns no_uris on empty input", async () => {
    const r = await tryPrefetchUris({ fs: {} }, { uris: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_uris");
  });

  it("returns api_not_available when surface.fs.prefetch is missing", async () => {
    const r = await tryPrefetchUris(
      { fs: {} },
      { uris: [{ scheme: "file", path: "/x" } as never] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("api_not_available");
  });

  it("forwards to prefetch when present and reports count", async () => {
    let called = 0;
    const r = await tryPrefetchUris(
      {
        fs: {
          prefetch: () => {
            called += 1;
            return Promise.resolve();
          },
        },
      },
      { uris: [{ scheme: "file", path: "/x" } as never, { scheme: "file", path: "/y" } as never] },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(2);
    if (r.ok) expect(r.prefetched).toBe(2);
  });

  it("captures errors via reason=error", async () => {
    const r = await tryPrefetchUris(
      { fs: { prefetch: () => Promise.reject(new Error("boom")) } },
      { uris: [{ scheme: "file", path: "/x" } as never] },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("error");
      expect(r.detail).toContain("boom");
    }
  });
});
