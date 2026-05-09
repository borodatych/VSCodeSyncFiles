/**
 * v2.12.1 — qrcode-terminal renderer tests.
 */
import { describe, expect, it } from "vitest";
import { renderQrToLines, renderChunkBlock } from "../../src/core/p2pQrTerminalRenderer.js";

interface FakeLib {
  generate: (text: string, opts: { small?: boolean }, cb: (s: string) => void) => void;
  setErrorLevel: (lvl: string) => void;
}

function fakeLib(rendering: string): FakeLib {
  return {
    generate: (_t, _o, cb) => { cb(rendering); },
    setErrorLevel: () => { /* no-op */ },
  };
}

describe("renderQrToLines", () => {
  it("returns module_not_installed when require throws cannot-find-module", () => {
    const r = renderQrToLines("payload", {
      loader: () => { throw new Error("Cannot find module 'qrcode-terminal'"); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("module_not_installed");
  });

  it("returns module_load_failed on other load errors", () => {
    const r = renderQrToLines("payload", {
      loader: () => { throw new Error("syntax error"); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("module_load_failed");
  });

  it("returns module_load_failed when export shape is unexpected", () => {
    const r = renderQrToLines("payload", { loader: () => ({ generate: 42 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("module_load_failed");
  });

  it("returns rendered lines on success", () => {
    const r = renderQrToLines("hello", { loader: () => fakeLib("###\n###\n") });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lines).toEqual(["###", "###"]);
  });

  it("rejects empty rendering as a load failure (sanity check)", () => {
    const r = renderQrToLines("hello", { loader: () => fakeLib("") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("module_load_failed");
  });
});

describe("renderChunkBlock", () => {
  it("prefixes the rendered QR with an index/total header", () => {
    const r = renderChunkBlock(
      { chunkIndex: 0, totalChunks: 3, sessionId: "s1", chunkLine: "VSS1|s1|0|3|abc" },
      { loader: () => fakeLib("##\n##\n") },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lines[0]).toBe("[1/3] sessionId=s1");
      expect(r.lines.slice(1)).toEqual(["##", "##"]);
    }
  });
});
