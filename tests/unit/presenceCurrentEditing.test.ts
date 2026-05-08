import { describe, expect, it } from "vitest";
import {
  buildCurrentEditingFrame,
  PRESENCE_THROTTLE_MS,
  scorePresenceRisk,
  shouldBroadcastCurrentEditing,
  type CurrentEditingFrame,
} from "../../src/core/presenceCurrentEditing.js";

describe("buildCurrentEditingFrame", () => {
  it("full mode writes literal relPath", () => {
    const f = buildCurrentEditingFrame({
      workspaceId: "ws1",
      relPath: "src/auth.ts",
      nowMs: 1000,
      mode: "full",
    });
    expect(f?.relPath).toBe("src/auth.ts");
  });

  it("anonymised mode writes 8-char hash", () => {
    const f = buildCurrentEditingFrame({
      workspaceId: "ws1",
      relPath: "src/auth.ts",
      nowMs: 1000,
      mode: "anonymised",
    });
    expect(f?.relPath).toMatch(/^[0-9a-f]{8}$/);
  });

  it("off mode returns null", () => {
    expect(
      buildCurrentEditingFrame({
        workspaceId: "ws1",
        relPath: "x",
        nowMs: 0,
        mode: "off",
      }),
    ).toBeNull();
  });
});

describe("shouldBroadcastCurrentEditing", () => {
  const frame = (rel: string, sinceMs: number): CurrentEditingFrame => ({
    workspaceId: "ws1",
    relPath: rel,
    sinceMs,
  });

  it("returns false when both last and next are null", () => {
    expect(
      shouldBroadcastCurrentEditing({ last: null, next: null, nowMs: 0 }),
    ).toBe(false);
  });

  it("returns true when transitioning null → editing", () => {
    expect(
      shouldBroadcastCurrentEditing({ last: null, next: frame("a", 0), nowMs: 0 }),
    ).toBe(true);
  });

  it("returns true when transitioning editing → null", () => {
    expect(
      shouldBroadcastCurrentEditing({ last: frame("a", 0), next: null, nowMs: 0 }),
    ).toBe(true);
  });

  it("returns true when file changes", () => {
    expect(
      shouldBroadcastCurrentEditing({
        last: frame("a", 0),
        next: frame("b", 5_000),
        nowMs: 5_000,
      }),
    ).toBe(true);
  });

  it("returns false when same file under throttle window", () => {
    expect(
      shouldBroadcastCurrentEditing({
        last: frame("a", 0),
        next: frame("a", 1_000),
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  it("returns true when same file past throttle window", () => {
    expect(
      shouldBroadcastCurrentEditing({
        last: frame("a", 0),
        next: frame("a", PRESENCE_THROTTLE_MS),
        nowMs: PRESENCE_THROTTLE_MS,
      }),
    ).toBe(true);
  });
});

describe("scorePresenceRisk", () => {
  const peer = (rel: string): CurrentEditingFrame => ({ workspaceId: "ws1", relPath: rel, sinceMs: 0 });

  it("returns 1.0 for exact relPath + workspace match", () => {
    expect(
      scorePresenceRisk({
        myWorkspaceId: "ws1",
        myRelPath: "src/auth.ts",
        peerCurrentEditing: peer("src/auth.ts"),
      }),
    ).toBe(1);
  });

  it("returns 0 for different workspace", () => {
    expect(
      scorePresenceRisk({
        myWorkspaceId: "ws-OTHER",
        myRelPath: "src/auth.ts",
        peerCurrentEditing: peer("src/auth.ts"),
      }),
    ).toBe(0);
  });

  it("returns 0.8 for anonymised match", () => {
    expect(
      scorePresenceRisk({
        myWorkspaceId: "ws1",
        myRelPath: "src/auth.ts",
        myAnonymised: "abcdef12",
        peerCurrentEditing: peer("abcdef12"),
      }),
    ).toBe(0.8);
  });

  it("returns 0 when peer is null (idle)", () => {
    expect(
      scorePresenceRisk({
        myWorkspaceId: "ws1",
        myRelPath: "x",
        peerCurrentEditing: null,
      }),
    ).toBe(0);
  });

  it("returns 0 for different file in same workspace", () => {
    expect(
      scorePresenceRisk({
        myWorkspaceId: "ws1",
        myRelPath: "a",
        peerCurrentEditing: peer("b"),
      }),
    ).toBe(0);
  });
});
