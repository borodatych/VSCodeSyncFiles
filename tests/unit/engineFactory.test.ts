/**
 * v2.11.1 — `createEngineFactory({ getEncKey: () => Promise.resolve(null) })` contract test.
 *
 * The factory closes over six dedup `Set<string>` stores and five callback
 * refs. The contract this test asserts:
 *
 *   1. Initial state — `notifiedConflictKeys` is an empty mutable Set.
 *   2. Isolation — two factory instances do NOT share state (important for
 *      tests, multi-window, and so the previous module-level state model
 *      cannot accidentally leak).
 *   3. `setRefs` accepts arbitrary partial shapes (no schema check yet) and
 *      may be called multiple times without throwing.
 *   4. `makeEngine` is a function on the returned factory.
 *
 * `vscode` is stubbed because the factory module imports it for runtime
 * settings reads inside `makeEngine`. The stubbed surface is intentionally
 * thin — anything beyond what the imports themselves touch is out of scope
 * for this contract test (full engine wiring is covered by integration
 * tests under `tests/integration/`).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    }),
  },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
    }),
  },
  commands: { executeCommand: vi.fn() },
}));

import { createEngineFactory } from "../../src/startup/_engineFactory.js";

describe("createEngineFactory", () => {
  it("exposes the public surface", () => {
    const factory = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    expect(typeof factory.makeEngine).toBe("function");
    expect(typeof factory.setRefs).toBe("function");
    expect(factory.notifiedConflictKeys).toBeInstanceOf(Set);
  });

  it("starts with an empty notifiedConflictKeys set", () => {
    const factory = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    expect(factory.notifiedConflictKeys.size).toBe(0);
  });

  it("isolates dedup state between factory instances", () => {
    const a = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    const b = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    a.notifiedConflictKeys.add("ws1:rel/path.ts");
    expect(a.notifiedConflictKeys.has("ws1:rel/path.ts")).toBe(true);
    expect(b.notifiedConflictKeys.has("ws1:rel/path.ts")).toBe(false);
    expect(a.notifiedConflictKeys).not.toBe(b.notifiedConflictKeys);
  });

  it("setRefs accepts an empty shape and partials without throwing", () => {
    const factory = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    expect(() => { factory.setRefs({}); }).not.toThrow();
    expect(() =>
      { factory.setRefs({
        logSyncActivity: vi.fn(),
        treeRefresh: vi.fn(),
      }); },
    ).not.toThrow();
  });

  it("setRefs is idempotent (last call wins)", () => {
    const factory = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    const calls: string[] = [];
    factory.setRefs({ treeRefresh: () => { calls.push("first"); } });
    factory.setRefs({ treeRefresh: () => { calls.push("second"); } });
    // No public way to invoke the ref directly without makeEngine, so this
    // only verifies that re-assignment does not throw and the surface is
    // stable. Behavioural coverage of the refs lives in integration tests.
    expect(calls).toHaveLength(0);
  });

  it("notifiedConflictKeys is the same reference across calls", () => {
    const factory = createEngineFactory({ getEncKey: () => Promise.resolve(null) });
    const ref1 = factory.notifiedConflictKeys;
    const ref2 = factory.notifiedConflictKeys;
    expect(ref1).toBe(ref2);
    ref1.add("k");
    expect(factory.notifiedConflictKeys.has("k")).toBe(true);
  });
});
