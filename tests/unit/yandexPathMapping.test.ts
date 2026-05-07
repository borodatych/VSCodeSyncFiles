/**
 * Yandex.Disk path encoding round-trip — `disk:/path` and `app:/path` formats.
 * The Yandex REST API uses these prefixes for full-disk vs app-folder scopes;
 * we round-trip them through `toDiskApiPath` / `cloudPathFromDiskApi` to make
 * sure leading slashes, doubled slashes, and the scope flag don't drift apart.
 */
import { describe, it, expect } from "vitest";
import {
  toDiskApiPath,
  cloudPathFromDiskApi,
} from "../../src/providers/yandex/yandexDiskProvider.js";

describe("yandex path mapping", () => {
  it("toDiskApiPath: full-disk prefix by default", () => {
    expect(toDiskApiPath("VSCodeSyncFiles/x.txt")).toBe("disk:/VSCodeSyncFiles/x.txt");
  });

  it("toDiskApiPath: app-folder prefix when useAppFolder=true", () => {
    expect(toDiskApiPath("workspace/x.txt", true)).toBe("app:/workspace/x.txt");
  });

  it("toDiskApiPath: strips leading slashes from input", () => {
    expect(toDiskApiPath("/leading/slash.txt")).toBe("disk:/leading/slash.txt");
    expect(toDiskApiPath("///many.txt")).toBe("disk:/many.txt");
    expect(toDiskApiPath("///many.txt", true)).toBe("app:/many.txt");
  });

  it("cloudPathFromDiskApi: round-trips full-disk paths", () => {
    expect(cloudPathFromDiskApi("disk:/VSCodeSyncFiles/x.txt")).toBe("VSCodeSyncFiles/x.txt");
    expect(cloudPathFromDiskApi("disk:/")).toBe("");
  });

  it("cloudPathFromDiskApi: round-trips app-folder paths", () => {
    expect(cloudPathFromDiskApi("app:/workspace/x.txt")).toBe("workspace/x.txt");
  });

  it("cloudPathFromDiskApi: tolerates raw paths without prefix", () => {
    expect(cloudPathFromDiskApi("/no/prefix.txt")).toBe("no/prefix.txt");
    expect(cloudPathFromDiskApi("no/prefix.txt")).toBe("no/prefix.txt");
  });

  it("round-trips arbitrary cloud path via both flavours", () => {
    const sample = "VSCodeSyncFiles/{ws-uuid}/file with spaces & 'quotes'.json";
    expect(cloudPathFromDiskApi(toDiskApiPath(sample, false))).toBe(sample);
    expect(cloudPathFromDiskApi(toDiskApiPath(sample, true))).toBe(sample);
  });
});
