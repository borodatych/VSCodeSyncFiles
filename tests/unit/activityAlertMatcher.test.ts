/**
 * Tests for `eventMatchesFilter` — the pure matcher used by the
 * Activity-feed alerting toast. Filter semantics:
 *   - kind: exact match, "any" / undefined = wildcard
 *   - workspaceId: exact match, undefined = wildcard
 *   - query: case-insensitive substring search across
 *     workspaceNote + relPath + machineName + detail.
 */
import { describe, it, expect } from "vitest";
import { eventMatchesFilter } from "../../src/ui/activityFilterMatch.js";
import type { ActivityEventInput } from "../../src/core/activityLog.js";

const baseEvent: ActivityEventInput = {
  kind: "push",
  workspaceId: "ws-uuid-abc",
  workspaceNote: "frontend",
  relPath: "src/auth/login.ts",
  machineName: "macbook",
  provider: "onedrive",
  detail: undefined,
};

describe("eventMatchesFilter", () => {
  it("empty filter matches everything", () => {
    expect(eventMatchesFilter(baseEvent, {})).toBe(true);
  });

  it("kind=any is treated as wildcard", () => {
    expect(eventMatchesFilter(baseEvent, { kind: "any" })).toBe(true);
  });

  it("kind exact-match positive", () => {
    expect(eventMatchesFilter(baseEvent, { kind: "push" })).toBe(true);
  });

  it("kind mismatch fails", () => {
    expect(eventMatchesFilter(baseEvent, { kind: "pull" })).toBe(false);
  });

  it("workspaceId exact-match", () => {
    expect(eventMatchesFilter(baseEvent, { workspaceId: "ws-uuid-abc" })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { workspaceId: "ws-uuid-other" })).toBe(false);
  });

  it("query is case-insensitive substring search across multiple fields", () => {
    expect(eventMatchesFilter(baseEvent, { query: "auth" })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { query: "AUTH" })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { query: "Login.TS" })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { query: "macbook" })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { query: "frontend" })).toBe(true);
  });

  it("query that does not appear anywhere fails", () => {
    expect(eventMatchesFilter(baseEvent, { query: "totally-unrelated" })).toBe(false);
  });

  it("query searches the optional detail field too", () => {
    const ev = { ...baseEvent, detail: "manifest schema mismatch" };
    expect(eventMatchesFilter(ev, { query: "schema" })).toBe(true);
  });

  it("multiple criteria are AND-combined", () => {
    expect(
      eventMatchesFilter(baseEvent, {
        kind: "push",
        workspaceId: "ws-uuid-abc",
        query: "auth",
      }),
    ).toBe(true);
    expect(
      eventMatchesFilter(baseEvent, {
        kind: "push",
        workspaceId: "ws-uuid-abc",
        query: "different-query",
      }),
    ).toBe(false);
  });

  it("blank / whitespace-only query is treated as no query", () => {
    expect(eventMatchesFilter(baseEvent, { query: "   " })).toBe(true);
    expect(eventMatchesFilter(baseEvent, { query: "" })).toBe(true);
  });
});
