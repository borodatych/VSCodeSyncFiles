import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAVE_DEBOUNCE_SEC,
  isIgnoredSyncTriggerPath,
  resolveSaveDebounceMs,
} from "../../src/core/syncTriggerLogic.js";

describe("syncTriggerLogic", () => {
  it("resolveSaveDebounceMs uses default 3s when unset", () => {
    expect(resolveSaveDebounceMs(undefined)).toBe(DEFAULT_SAVE_DEBOUNCE_SEC * 1000);
    expect(resolveSaveDebounceMs({})).toBe(DEFAULT_SAVE_DEBOUNCE_SEC * 1000);
  });

  it("resolveSaveDebounceMs respects per-workspace seconds", () => {
    expect(resolveSaveDebounceMs({ saveDebounceSec: 0 })).toBe(0);
    expect(resolveSaveDebounceMs({ saveDebounceSec: 1 })).toBe(1000);
    expect(resolveSaveDebounceMs({ saveDebounceSec: -1 })).toBe(0);
  });

  it("isIgnoredSyncTriggerPath detects vscodesync.json", () => {
    expect(isIgnoredSyncTriggerPath("D:\\proj\\.vscode\\vscodesync.json")).toBe(true);
    expect(isIgnoredSyncTriggerPath("/home/u/proj/.vscode/vscodesync.json")).toBe(true);
    expect(isIgnoredSyncTriggerPath("D:\\proj\\src\\foo.ts")).toBe(false);
  });
});
