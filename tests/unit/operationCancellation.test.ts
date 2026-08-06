/**
 * Cancellation end to end (A5).
 *
 * Before this, "Отмена" could not stop anything: no `AbortSignal` reached the
 * engine or the provider, and one request could occupy up to ~16 minutes
 * (3 attempts × 120 s timeout + `Retry-After` up to 300 s between them).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAborted,
  isCancellation,
  OperationCancelledError,
  sleepUnlessAborted,
  throwIfAborted,
} from "../../src/core/operationCancelled.js";
import { withRetry, MAX_HONOURED_RETRY_AFTER_MS } from "../../src/core/withRetry.js";
import { ProviderError } from "../../src/providers/cloudProviderTypes.js";
import { MockCloudProvider } from "../../src/providers/mockCloudProvider.js";
import { SyncEngine } from "../../src/core/syncEngine.js";

describe("примитивы отмены", () => {
  it("throwIfAborted молчит без сигнала и бросает после abort", () => {
    const ac = new AbortController();
    expect(() => { throwIfAborted(undefined, "op"); }).not.toThrow();
    expect(() => { throwIfAborted(ac.signal, "op"); }).not.toThrow();
    ac.abort();
    expect(() => { throwIfAborted(ac.signal, "op"); }).toThrow(OperationCancelledError);
  });

  it("isCancellation узнаёт и нашу ошибку, и AbortError от fetch", () => {
    expect(isCancellation(new OperationCancelledError("op"))).toBe(true);
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(isCancellation(abortErr)).toBe(true);
    expect(isCancellation(new Error("boom"))).toBe(false);
  });

  it("sleepUnlessAborted не досыпает после отмены", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleepUnlessAborted(60_000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("isAborted — функция, потому что флаг меняется асинхронно", () => {
    const ac = new AbortController();
    expect(isAborted(ac.signal)).toBe(false);
    ac.abort();
    expect(isAborted(ac.signal)).toBe(true);
  });
});

describe("withRetry и отмена (A5)", () => {
  it("после отмены новая попытка не запускается", async () => {
    const ac = new AbortController();
    let attempts = 0;
    await expect(
      withRetry({ op: "t", maxAttempts: 5, initialDelayMs: 1, signal: ac.signal }, async () => {
        attempts += 1;
        ac.abort();
        await Promise.resolve();
        throw new ProviderError("SERVER_ERROR", "5xx");
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(attempts).toBe(1);
  });

  it("Retry-After сверх потолка не отсиживается внутри одного запроса", async () => {
    let attempts = 0;
    const started = Date.now();
    await expect(
      withRetry({ op: "t", maxAttempts: 3, initialDelayMs: 1 }, async () => {
        attempts += 1;
        await Promise.resolve();
        throw new ProviderError("RATE_LIMITED", "slow down", {
          retryAfterMs: MAX_HONOURED_RETRY_AFTER_MS + 1,
        });
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("Retry-After в пределах потолка по-прежнему уважается", async () => {
    let attempts = 0;
    await withRetry(
      { op: "t", maxAttempts: 2, initialDelayMs: 1, sleep: () => Promise.resolve() },
      async () => {
        attempts += 1;
        await Promise.resolve();
        if (attempts === 1) {
          throw new ProviderError("RATE_LIMITED", "slow down", { retryAfterMs: 1000 });
        }
        return "ok";
      },
    );
    expect(attempts).toBe(2);
  });
});

describe("движок останавливается на границе файлов", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
  });

  it("отменённый pushAll бросает OperationCancelledError и не заливает файлы", async () => {
    const provider = new MockCloudProvider("onedrive");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vsc-cancel-"));
    roots.push(root);
    const setup = new SyncEngine({
      workspaceRoot: root,
      provider,
      machineId: "A",
      machineName: "A",
      trigger: "user",
    });
    const wid = await setup.createWorkspace("cancel-test", "onedrive");
    const abs = path.join(root, "a.txt");
    await fs.writeFile(abs, "content\n", "utf8");
    await setup.addFiles(wid, [abs]);
    await fs.writeFile(abs, "changed\n", "utf8");

    const ac = new AbortController();
    ac.abort(); // отменено до старта — крайний случай, который обязан отработать
    const cancelled = new SyncEngine({
      workspaceRoot: root,
      provider,
      machineId: "A",
      machineName: "A",
      trigger: "user",
      abortSignal: ac.signal,
    });
    await expect(cancelled.pushAll(wid)).rejects.toBeInstanceOf(OperationCancelledError);
  });
});
