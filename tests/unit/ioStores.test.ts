/**
 * Behaviour of the `src/core/io/` layer (этап 5.2), tested against the mock
 * provider instead of a whole engine.
 */
import { describe, expect, it, vi } from "vitest";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import { createMetaStore } from "../../src/core/io/metaStore.js";
import {
  createManifestStore,
  ManifestCorruptError,
  purgeTombstones,
} from "../../src/core/io/manifestStore.js";
import { createHistoryStore } from "../../src/core/io/historyStore.js";
import { createBlobTransfer } from "../../src/core/io/blobTransfer.js";
import { manifestCloudPath, metaCloudPath, type CloudManifest } from "../../src/core/cloudLayout.js";

const WS = "ws-1";

function manifest(files: CloudManifest["files"] = []): CloudManifest {
  return {
    schemaVersion: 1,
    workspaceId: WS,
    workspaceNote: "note",
    tags: [],
    sharedIgnorePatterns: [],
    providerType: "onedrive",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files,
    machines: [],
  } as unknown as CloudManifest;
}

function metaStoreFor(provider: MockCloudProvider, over: Record<string, unknown> = {}) {
  return createMetaStore({
    provider,
    metaWriteRetries: () => 3,
    onEtag: () => Promise.resolve(),
    beforeWrite: () => Promise.resolve(),
    ...over,
  });
}

describe("metaStore", () => {
  it("отсутствующая мета читается как пустая, а не как ошибка", async () => {
    const store = metaStoreFor(new MockCloudProvider("onedrive"));
    await expect(store.pull(WS, undefined)).resolves.toEqual({ files: {} });
  });

  it("push → pull возвращает записанное и обновляет кэш", async () => {
    const provider = new MockCloudProvider("onedrive");
    const store = metaStoreFor(provider);
    await store.push(WS, { files: { "a.ts": { hash: "H", etag: "E", version: 1, machineId: "m", updatedAt: "t" } } }, undefined, "push");
    expect(store.peek(WS)?.files["a.ts"]?.hash).toBe("H");
    await expect(provider.downloadFile(metaCloudPath(WS))).resolves.toBeTruthy();
  });

  it("beforeWrite может запретить запись — в облако ничего не уходит", async () => {
    const provider = new MockCloudProvider("onedrive");
    const store = metaStoreFor(provider, {
      beforeWrite: () => Promise.reject(new Error("read-only window")),
    });
    await expect(store.push(WS, { files: {} }, undefined, "push")).rejects.toThrow("read-only");
    await expect(provider.downloadFile(metaCloudPath(WS))).rejects.toBeInstanceOf(ProviderError);
  });

  it("forget очищает кэш", () => {
    const store = metaStoreFor(new MockCloudProvider("onedrive"));
    store.put(WS, { files: {} });
    store.forget(WS);
    expect(store.peek(WS)).toBeUndefined();
  });
});

describe("manifestStore", () => {
  function storeFor(provider: MockCloudProvider, over: Record<string, unknown> = {}) {
    return createManifestStore({
      provider,
      tombstonePurgeDays: () => 30,
      onEtag: () => Promise.resolve(),
      currentEtag: () => Promise.resolve(undefined),
      beforeWrite: () => Promise.resolve(),
      ...over,
    });
  }

  it("отсутствующий манифест → null (это «удалён другой машиной»)", async () => {
    const store = storeFor(new MockCloudProvider("onedrive"));
    await expect(store.download(WS, undefined)).resolves.toBeNull();
  });

  it("битый манифест бросает, а не притворяется отсутствующим", async () => {
    const provider = new MockCloudProvider("onedrive");
    await provider.uploadFile(manifestCloudPath(WS), Buffer.from("{ not json", "utf8"));
    const onCorrupt = vi.fn();
    const store = storeFor(provider, { onCorrupt });
    await expect(store.download(WS, undefined)).rejects.toBeInstanceOf(ManifestCorruptError);
    expect(onCorrupt).toHaveBeenCalled();
  });

  it("put → download делает круг", async () => {
    const provider = new MockCloudProvider("onedrive");
    const store = storeFor(provider);
    await store.put(WS, manifest([{ path: "a.ts", addedAt: "2026-01-01T00:00:00.000Z", version: 1 } as never]), undefined);
    const back = await store.download(WS, undefined);
    expect(back?.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("mass-change guard может отменить запись", async () => {
    const provider = new MockCloudProvider("onedrive");
    const store = storeFor(provider, { onMassChange: () => Promise.resolve(false) });
    // Сначала «много» файлов, затем почти все под tombstone.
    const many = Array.from({ length: 60 }, (_, i) => ({ path: `f${String(i)}.ts`, addedAt: "2026-01-01T00:00:00.000Z", version: 1 }));
    await store.put(WS, manifest(many as never), undefined);
    const tombstoned = many.map((f) => ({ ...f, removedAt: new Date().toISOString() }));
    await expect(store.put(WS, manifest(tombstoned as never), undefined)).rejects.toThrow(
      "mass-change guard",
    );
  });
});

describe("purgeTombstones", () => {
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();

  it("удаляет старые tombstone и оставляет свежие", () => {
    const m = manifest([
      { path: "gone-old.ts", removedAt: old },
      { path: "gone-new.ts", removedAt: recent },
      { path: "alive.ts" },
    ] as never);
    const r = purgeTombstones(m, 30);
    expect(r.files.map((f) => f.path)).toEqual(["gone-new.ts", "alive.ts"]);
  });

  it("0 дней — ничего не удаляет", () => {
    const m = manifest([{ path: "gone.ts", removedAt: old }] as never);
    expect(purgeTombstones(m, 0)).toBe(m);
  });

  it("старая метка переименования снимается, файл остаётся", () => {
    const m = manifest([{ path: "b.ts", renamedFrom: "a.ts", renamedAt: old }] as never);
    const r = purgeTombstones(m, 30);
    expect(r.files[0]).toEqual({ path: "b.ts" });
  });
});

describe("historyStore", () => {
  function storeFor(provider: MockCloudProvider, mode: "inline" | "lazy" | "off") {
    return createHistoryStore({
      provider,
      machineName: "M",
      mode: () => mode,
      versions: () => 2,
    });
  }

  it("off — ничего не пишет и не копит", async () => {
    const provider = new MockCloudProvider("onedrive");
    const store = storeFor(provider, "off");
    await store.snapshot(WS, "a.ts", "some/path");
    expect(store.pending()).toBe(0);
  });

  it("lazy — копит и отдаёт одним drain", async () => {
    const store = storeFor(new MockCloudProvider("onedrive"), "lazy");
    await store.snapshot(WS, "a.ts", "p1");
    await store.snapshot(WS, "b.ts", "p2");
    expect(store.pending()).toBe(2);
    expect(store.drain().map((e) => e.posixRel)).toEqual(["a.ts", "b.ts"]);
    expect(store.pending()).toBe(0);
  });

  it("отсутствующий исходный блоб не ошибка", async () => {
    const store = storeFor(new MockCloudProvider("onedrive"), "inline");
    await expect(store.snapshot(WS, "a.ts", "missing/path")).resolves.toBeUndefined();
  });
});

describe("blobTransfer", () => {
  const transfer = (provider: MockCloudProvider, decrypt?: (b: Buffer) => Buffer) =>
    createBlobTransfer({
      provider,
      decrypt,
      hashCfg: () => ({ lineEnding: "lf" }),
      verifyRetries: () => 2,
    });

  it("удаление отсутствующего блоба — успех", async () => {
    await expect(
      transfer(new MockCloudProvider("onedrive")).deleteBestEffort("nope"),
    ).resolves.toBeUndefined();
  });

  it("decode применяет decrypt", () => {
    const t = transfer(new MockCloudProvider("onedrive"), (b) => b.subarray(1));
    expect(t.decode(Buffer.from([0xaa, 0x68, 0x69]), false).toString("utf8")).toBe("hi");
  });

  it("verifyUpload падает, когда в облаке лежит не то", async () => {
    const provider = new MockCloudProvider("onedrive");
    await provider.uploadFile("p", Buffer.from("actual", "utf8"));
    await expect(
      transfer(provider).verifyUpload("p", "expected-hash", "a.ts", false),
    ).rejects.toThrow("hash mismatch");
  });
});

describe("manifestStore — авторемонт дублей linkId в 412-merge", () => {
  function storeFor(provider: MockCloudProvider, currentEtag: () => Promise<string | undefined>) {
    return createManifestStore({
      provider,
      tombstonePurgeDays: () => 30,
      onEtag: () => Promise.resolve(),
      currentEtag,
      beforeWrite: () => Promise.resolve(),
    });
  }

  it("bind × canonical-rename: после merge выживает один носитель идентичности", async () => {
    const provider = new MockCloudProvider("onedrive");
    // Облако: наследник rename несёт идентичность на новом пути (моложе).
    const cloudRow = {
      path: "lib/a.ts", addedAt: "2026-08-12T10:00:00.000Z", version: 5,
      hasSyncignoreMarkers: false, linkId: "aabbccdd00112233",
      renamedFrom: "src/a.ts", renamedAt: "2026-08-12T10:00:00.000Z",
    };
    const up = await provider.uploadFile(
      manifestCloudPath(WS),
      Buffer.from(JSON.stringify(manifest([cloudRow as never])), "utf8"),
    );
    const store = storeFor(provider, () => Promise.resolve(up.etag));
    // Наш PUT с устаревшим etag: та же идентичность живёт на старом пути.
    const staleRow = {
      path: "src/a.ts", addedAt: "2026-08-11T00:00:00.000Z", version: 6,
      hasSyncignoreMarkers: false, linkId: "aabbccdd00112233",
    };
    await store.put(WS, manifest([staleRow]), 'W/"stale"');
    const final = await store.download(WS, undefined);
    const live = final?.files.filter((f) => !f.removedAt) ?? [];
    expect(live.map((f) => f.path)).toEqual(["lib/a.ts"]);
    const tomb = final?.files.find((f) => f.path === "src/a.ts");
    expect(tomb?.removedAt).toBeTruthy();
  });
});
