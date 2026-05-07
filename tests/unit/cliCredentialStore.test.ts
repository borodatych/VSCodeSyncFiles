import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createFileSecretStore, hasFileCredential } from "../../cli/src/credentialStore.js";

async function makeTempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vscodesync-cli-test-"));
  return path.join(dir, "creds.json");
}

describe("createFileSecretStore", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    for (const p of cleanups) {
      try {
        await fs.rm(path.dirname(p), { recursive: true, force: true });
      } catch { /* noop */ }
    }
    cleanups.length = 0;
  });

  it("returns undefined for missing key", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a key", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    await store.store("vscodesync.onedrive.oauth", JSON.stringify({ accessToken: "tok123" }));
    const val = await store.get("vscodesync.onedrive.oauth");
    expect(val).toBeDefined();
    expect(JSON.parse(val!)).toMatchObject({ accessToken: "tok123" });
  });

  it("deletes a key", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    await store.store("key1", "value1");
    await store.delete("key1");
    expect(await store.get("key1")).toBeUndefined();
  });

  it("persists across store instances (reads from file)", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store1 = createFileSecretStore(p);
    await store1.store("mykey", "myval");

    const store2 = createFileSecretStore(p);
    expect(await store2.get("mykey")).toBe("myval");
  });

  it("multiple keys coexist", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    await store.store("k1", "v1");
    await store.store("k2", "v2");
    expect(await store.get("k1")).toBe("v1");
    expect(await store.get("k2")).toBe("v2");
  });
});

describe("hasFileCredential", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    for (const p of cleanups) {
      try {
        await fs.rm(path.dirname(p), { recursive: true, force: true });
      } catch { /* noop */ }
    }
    cleanups.length = 0;
  });

  it("returns false when file does not exist", async () => {
    expect(await hasFileCredential("any.key", "/nonexistent/path/creds.json")).toBe(false);
  });

  it("returns true when key exists in file", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    await store.store("vscodesync.onedrive.oauth", "tok");
    expect(await hasFileCredential("vscodesync.onedrive.oauth", p)).toBe(true);
  });

  it("returns false for absent key in existing file", async () => {
    const p = await makeTempFile();
    cleanups.push(p);
    const store = createFileSecretStore(p);
    await store.store("other.key", "tok");
    expect(await hasFileCredential("vscodesync.onedrive.oauth", p)).toBe(false);
  });
});
