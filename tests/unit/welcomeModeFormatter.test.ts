import { describe, expect, it } from "vitest";
import { buildWelcomeMessage } from "../../src/core/welcomeModeFormatter.js";

describe("buildWelcomeMessage", () => {
  it("conflicts win regardless of mode", () => {
    const m = buildWelcomeMessage("full", 0, 0, 3);
    expect(m.headline).toContain("конфликте");
    expect(m.ctaCommandId).toBe("vscodesync.resolveConflicts");
  });

  it("mode=off + pending → suggest bulkPush", () => {
    const m = buildWelcomeMessage("off", 5, 0, 0);
    expect(m.headline).toContain("выключена");
    expect(m.ctaCommandId).toBe("vscodesync.bulkPush");
  });

  it("mode=off + idle → suggest mode change", () => {
    const m = buildWelcomeMessage("off", 0, 0, 0);
    expect(m.ctaCommandId).toBe("vscodesync.cycleAutoSyncMode");
  });

  it("mode=check-only + pending → suggest pushAll", () => {
    const m = buildWelcomeMessage("check-only", 7, 0, 0);
    expect(m.ctaCommandId).toBe("vscodesync.pushAll");
    expect(m.headline).toContain("Push");
  });

  it("mode=check-only + cloud_newer → suggest pullAll", () => {
    const m = buildWelcomeMessage("check-only", 0, 4, 0);
    expect(m.ctaCommandId).toBe("vscodesync.pullAll");
  });

  it("mode=full + idle → 'all synced'", () => {
    const m = buildWelcomeMessage("full", 0, 0, 0);
    expect(m.headline).toContain("актуально");
    expect(m.ctaCommandId).toBeUndefined();
  });

  it("Russian plural agreement for 1 / 2 / 5", () => {
    const m1 = buildWelcomeMessage("check-only", 1, 0, 0);
    const m2 = buildWelcomeMessage("check-only", 2, 0, 0);
    const m5 = buildWelcomeMessage("check-only", 5, 0, 0);
    expect(m1.headline).toContain("файл ");
    expect(m2.headline).toContain("файла");
    expect(m5.headline).toContain("файлов");
  });
});
