import { describe, it, expect } from "vitest";
import {
  appendReplayEvent,
  endReplaySession,
  parseReplaySession,
  startReplaySession,
  summarizeReplay,
  MAX_EVENTS,
} from "../../src/core/syncReplayRecorder.js";

const T0 = "2026-05-01T00:00:00.000Z";
const T1 = "2026-05-01T00:01:30.000Z";

describe("session lifecycle", () => {
  it("starts and assigns step numbers", () => {
    let s = startReplaySession("sid", T0, "home");
    s = appendReplayEvent(s, { at: T0, kind: "push", workspaceId: "A", relPath: "a.ts", provider: "onedrive" });
    s = appendReplayEvent(s, { at: T0, kind: "manifest_write", workspaceId: "A", relPath: "", provider: "onedrive" });
    expect(s.events[0]?.step).toBe(1);
    expect(s.events[1]?.step).toBe(2);
  });
  it("rolls events when reaching MAX_EVENTS", () => {
    let s = startReplaySession("sid", T0);
    for (let i = 0; i < MAX_EVENTS + 5; i++) {
      s = appendReplayEvent(s, { at: T0, kind: "push", workspaceId: "A", relPath: `f${String(i)}`, provider: "onedrive" });
    }
    expect(s.events.length).toBe(MAX_EVENTS);
    expect(s.events[0]?.relPath).toBe("f5");
  });
  it("endReplaySession sets endedAt", () => {
    const s = startReplaySession("sid", T0);
    const ended = endReplaySession(s, T1);
    expect(ended.endedAt).toBe(T1);
  });
});

describe("parseReplaySession", () => {
  it("returns undefined on bad shape", () => {
    expect(parseReplaySession(null)).toBeUndefined();
    expect(parseReplaySession({ schema: 99 })).toBeUndefined();
    expect(parseReplaySession({ schema: 1 })).toBeUndefined();
  });
  it("filters bad events", () => {
    const r = parseReplaySession({
      schema: 1,
      sessionId: "sid",
      startedAt: T0,
      events: [
        { step: 1, at: T0, kind: "push", workspaceId: "A", relPath: "a.ts", provider: "onedrive" },
        { step: 2, at: T0, kind: "BAD_KIND", workspaceId: "A", relPath: "a.ts", provider: "onedrive" },
        { step: 3 }, // missing fields
      ],
    });
    expect(r?.events.length).toBe(1);
  });
});

describe("summarizeReplay", () => {
  it("counts by kind and workspace", () => {
    let s = startReplaySession("sid", T0);
    s = appendReplayEvent(s, { at: T0, kind: "push", workspaceId: "A", relPath: "a", provider: "onedrive" });
    s = appendReplayEvent(s, { at: T0, kind: "pull", workspaceId: "A", relPath: "a", provider: "onedrive" });
    s = appendReplayEvent(s, { at: T0, kind: "conflict", workspaceId: "B", relPath: "b", provider: "onedrive" });
    s = endReplaySession(s, T1);
    const sum = summarizeReplay(s);
    expect(sum.totalEvents).toBe(3);
    expect(sum.byKind.push).toBe(1);
    expect(sum.byKind.pull).toBe(1);
    expect(sum.byKind.conflict).toBe(1);
    expect(sum.workspaceCount).toBe(2);
    expect(sum.durationMs).toBe(90_000);
  });
});
