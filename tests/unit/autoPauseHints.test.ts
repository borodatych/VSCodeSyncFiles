import { describe, expect, it } from "vitest";
import { parsePmsetBatteryPercent } from "../../src/utils/batteryPercent.js";
import { readNavigatorMetered } from "../../src/utils/networkMetered.js";

describe("parsePmsetBatteryPercent", () => {
  it("parses percentage from pmset output", () => {
    expect(parsePmsetBatteryPercent("Battery-0 (InternalBattery-0): 87%; discharging;")).toBe(87);
  });

  it("returns null when no match", () => {
    expect(parsePmsetBatteryPercent("no battery")).toBeNull();
  });
});

describe("readNavigatorMetered", () => {
  it("returns null when navigator.connection missing", () => {
    expect(readNavigatorMetered()).toBeNull();
  });
});
