/**
 * v2.20.4 — SSE decoder tests.
 */
import { describe, expect, it } from "vitest";
import { createSseDecoder, SseTransportNotImplementedError } from "../../src/core/webhookSseDecoder.js";

describe("createSseDecoder", () => {
  it("decodes a single event terminated by blank line", () => {
    const d = createSseDecoder();
    const out = d.push("event: change\ndata: hello\n\n");
    expect(out).toEqual([{ event: "change", data: "hello" }]);
  });

  it("defaults event name to message", () => {
    const d = createSseDecoder();
    const out = d.push("data: hi\n\n");
    expect(out).toEqual([{ event: "message", data: "hi" }]);
  });

  it("joins multi-line data with \\n", () => {
    const d = createSseDecoder();
    const out = d.push("data: line one\ndata: line two\n\n");
    expect(out[0]?.data).toBe("line one\nline two");
  });

  it("captures id and tracks lastEventId", () => {
    const d = createSseDecoder();
    d.push("id: 7\ndata: x\n\n");
    expect(d.state().lastEventId).toBe("7");
  });

  it("ignores comment lines (keepalives)", () => {
    const d = createSseDecoder();
    const out = d.push(":keepalive\n\ndata: y\n\n");
    expect(out).toEqual([{ event: "message", data: "y" }]);
  });

  it("buffers across chunks until boundary arrives", () => {
    const d = createSseDecoder();
    const a = d.push("data: ping");
    expect(a).toEqual([]);
    const b = d.push("\n\n");
    expect(b).toEqual([{ event: "message", data: "ping" }]);
  });

  it("handles \\r\\n line endings", () => {
    const d = createSseDecoder();
    const out = d.push("event: change\r\ndata: hi\r\n\r\n");
    expect(out).toEqual([{ event: "change", data: "hi" }]);
  });

  it("captures retry hint", () => {
    const d = createSseDecoder();
    const out = d.push("retry: 5000\ndata: x\n\n");
    expect(out[0]?.retryMs).toBe(5000);
  });

  it("ignores blocks with no data: field", () => {
    const d = createSseDecoder();
    const out = d.push("event: change\nid: 1\n\n");
    expect(out).toEqual([]);
  });
});

describe("SseTransportNotImplementedError", () => {
  it("has the documented code", () => {
    const e = new SseTransportNotImplementedError();
    expect(e.code).toBe("sse_transport_not_implemented");
  });
});
