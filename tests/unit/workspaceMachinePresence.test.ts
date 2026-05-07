import { describe, expect, it } from "vitest";
import {
  formatMachinePresenceLines,
  machinePresenceEmoji,
} from "../../src/ui/workspaceMachinePresence.js";
import type { ManifestMachineCacheEntry } from "../../src/core/types.js";

describe("workspaceMachinePresence", () => {
  it("marks current machine with (вы)", () => {
    const machines: ManifestMachineCacheEntry[] = [
      { machineId: "a", machineName: "home", lastSeen: new Date().toISOString() },
    ];
    const lines = formatMachinePresenceLines(machines, "a");
    expect(lines.some((l) => l.includes("(вы)"))).toBe(true);
  });

  it("emoji green for fresh lastSeen", () => {
    expect(machinePresenceEmoji(new Date().toISOString())).toBe("🟢");
  });

  it("emoji red for old lastSeen", () => {
    const old = new Date(Date.now() - 48 * 3600_000).toISOString();
    expect(machinePresenceEmoji(old)).toBe("🔴");
  });
});
