/**
 * Unit tests for the SSE-parser helper used by `webhookTunnel.ts`.
 *
 * Covers: heartbeat, malformed JSON, body-as-object envelope, headers split,
 * multi-line `data:` reassembly. The parser is in a vscode-free module so we
 * can test it without mocking the editor surface.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parseSmeeSseBlock,
  type SmeePayload,
} from "../../src/ui/webhookSseParser.js";

describe("webhookSseParser.parseSmeeSseBlock", () => {
  it("ignores empty SSE blocks", () => {
    const handler = vi.fn();
    parseSmeeSseBlock("", handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores heartbeat 'connected' marker", () => {
    const handler = vi.fn();
    parseSmeeSseBlock("data:connected\n", handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores blocks without a data: line (event-only frames)", () => {
    const handler = vi.fn();
    parseSmeeSseBlock("event: ready\nid: 1\n", handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON without throwing", () => {
    const handler = vi.fn();
    expect(() => { parseSmeeSseBlock('data:{not-json', handler); }).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches a typical smee envelope (body + string headers)", () => {
    const handler = vi.fn<(p: SmeePayload) => void>();
    const envelope = JSON.stringify({
      body: { foo: 1, bar: ["a", "b"] },
      "user-agent": "GitHub-Hookshot/abc",
      "x-goog-channel-token": "secret",
      timestamp: 1700000000,
    });
    parseSmeeSseBlock(`data:${envelope}\n`, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    const arg = handler.mock.calls[0][0];
    expect(arg.body).toEqual({ foo: 1, bar: ["a", "b"] });
    // Only string-typed top-level fields land in `headers`; numeric `timestamp` is dropped.
    expect(arg.headers).toEqual({
      "user-agent": "GitHub-Hookshot/abc",
      "x-goog-channel-token": "secret",
    });
  });

  it("falls back to entire envelope as body when 'body' key is missing", () => {
    const handler = vi.fn<(p: SmeePayload) => void>();
    const envelope = JSON.stringify({ status: "ok", value: 42 });
    parseSmeeSseBlock(`data:${envelope}\n`, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].body).toEqual({ status: "ok", value: 42 });
  });

  it("reassembles multi-line data: payloads (SSE spec compliance)", () => {
    const handler = vi.fn<(p: SmeePayload) => void>();
    const envelope = JSON.stringify({ body: { multi: true } });
    const half = envelope.length / 2;
    const block = `data:${envelope.slice(0, half)}\ndata:${envelope.slice(half)}\n`;
    parseSmeeSseBlock(block, handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].body).toEqual({ multi: true });
  });
});
