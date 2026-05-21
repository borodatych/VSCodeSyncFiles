import { describe, expect, it } from "vitest";
import {
  EMPTY_RC,
  parseVscodesyncRc,
  resolveSettingWithRc,
} from "../../src/core/vscodesyncRc.js";

describe("parseVscodesyncRc", () => {
  it("happy path", () => {
    const r = parseVscodesyncRc(JSON.stringify({
      schemaVersion: 1,
      settings: {
        autoSyncMode: "off",
        "sync.concurrency": 2,
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rc.settings.autoSyncMode).toBe("off");
      expect(r.rejectedKeys).toEqual([]);
    }
  });

  it("filters out non-allowlisted keys", () => {
    const r = parseVscodesyncRc(JSON.stringify({
      schemaVersion: 1,
      settings: {
        autoSyncMode: "full",
        secretToken: "leak",
        "onedriveClientId": "spoof",
      },
    }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rejectedKeys.sort()).toEqual(["onedriveClientId", "secretToken"]);
      expect(Object.keys(r.rc.settings)).toEqual(["autoSyncMode"]);
    }
  });

  it("rejects bad JSON", () => {
    const r = parseVscodesyncRc("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("json_failed");
  });

  it("rejects wrong schema version", () => {
    const r = parseVscodesyncRc(JSON.stringify({ schemaVersion: 2, settings: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_schema");
  });

  it("rejects array root", () => {
    const r = parseVscodesyncRc("[1,2,3]");
    expect(r.ok).toBe(false);
  });

  it("preserves description", () => {
    const r = parseVscodesyncRc(JSON.stringify({
      schemaVersion: 1,
      settings: {},
      description: "team policy",
    }));
    if (r.ok) {
      expect(r.rc.description).toBe("team policy");
    }
  });
});

describe("resolveSettingWithRc", () => {
  it("returns VS Code value when rc is null", () => {
    expect(resolveSettingWithRc("autoSyncMode", null, "full")).toBe("full");
  });

  it("returns rc value when override present", () => {
    const rc = parseVscodesyncRc(JSON.stringify({
      schemaVersion: 1,
      settings: { autoSyncMode: "off" },
    }));
    if (rc.ok) {
      expect(resolveSettingWithRc("autoSyncMode", rc.rc, "full")).toBe("off");
    }
  });

  it("returns VS Code value when key not in rc", () => {
    expect(resolveSettingWithRc("autoSyncMode", EMPTY_RC, "full")).toBe("full");
  });

  it("non-allowlisted key cannot be overridden", () => {
    const rc = { schemaVersion: 1, settings: { onedriveClientId: "evil" } };
    expect(resolveSettingWithRc("onedriveClientId", rc, "real-client-id")).toBe("real-client-id");
  });
});
