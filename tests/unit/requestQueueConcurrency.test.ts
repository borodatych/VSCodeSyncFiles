import { describe, it, expect } from "vitest";
import {
  RequestQueue,
  RequestQueueOverflowError,
  RequestQueueTimeoutError,
  getGlobalQueue,
  disposeGlobalQueue,
} from "../../src/core/requestQueue.js";

describe("RequestQueue — concurrency serialization", () => {
  it("executes N concurrent enqueues sequentially (concurrency = 1)", async () => {
    const queue = new RequestQueue({ concurrency: 1 });
    const order: number[] = [];

    const tasks = [0, 1, 2, 3, 4].map((i) =>
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            order.push(i);
            resolve();
          }),
      ),
    );

    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("concurrent enqueues do not run in parallel (concurrency = 1)", async () => {
    const queue = new RequestQueue({ concurrency: 1 });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 8 }, () =>
      queue.enqueue(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((r) => setTimeout(r, 1));
        running--;
      }),
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(1);
  });

  it("concurrency = 2 allows at most 2 parallel", async () => {
    const queue = new RequestQueue({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 6 }, () =>
      queue.enqueue(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((r) => setTimeout(r, 5));
        running--;
      }),
    );

    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBeGreaterThanOrEqual(1);
  });

  it("getGlobalQueue returns same instance for same namespace", () => {
    disposeGlobalQueue("test-ns");
    const q1 = getGlobalQueue("test-ns");
    const q2 = getGlobalQueue("test-ns");
    expect(q1).toBe(q2);
    disposeGlobalQueue("test-ns");
  });

  it("pendingCount and activeCount reflect queue state", async () => {
    const queue = new RequestQueue({ concurrency: 1 });
    let resolveFirst!: () => void;
    const first = queue.enqueue(
      () => new Promise<void>((r) => { resolveFirst = r; }),
    );
    // Give the queue a tick to start the first task
    await new Promise<void>((r) => setTimeout(r, 0));

    // Enqueue two more while first is running
    const second = queue.enqueue(() => Promise.resolve());
    const third = queue.enqueue(() => Promise.resolve());

    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(2);

    resolveFirst();
    await Promise.all([first, second, third]);
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it("timeout option rejects after deadline", async () => {
    const queue = new RequestQueue({ concurrency: 1, timeoutMs: 20 });
    await expect(
      queue.enqueue(() => new Promise<void>((r) => setTimeout(r, 200))),
    ).rejects.toBeInstanceOf(RequestQueueTimeoutError);
  });

  it("слот освобождается по дедлайну, и очередь продолжает работать", async () => {
    // The point of the deadline: an operation that never settles must not hold
    // its slot forever. Before the fix `timeoutMs` defaulted to 0, no watchdog
    // was armed, and everything behind such an operation waited indefinitely.
    const queue = new RequestQueue({ concurrency: 1, timeoutMs: 20 });
    const stuck = queue.enqueue(() => new Promise<void>(() => { /* never settles */ }));
    await expect(stuck).rejects.toBeInstanceOf(RequestQueueTimeoutError);
    expect(queue.timedOutCount).toBe(1);
    await expect(queue.enqueue(() => Promise.resolve("next"))).resolves.toBe("next");
    expect(queue.activeCount).toBe(0);
  });

  it("переполнение очереди отклоняется вместо бесконечного роста", async () => {
    const queue = new RequestQueue({ concurrency: 1, timeoutMs: 0, maxPending: 2 });
    const block = queue.enqueue(() => new Promise<void>((r) => setTimeout(r, 30)));
    const q1 = queue.enqueue(() => Promise.resolve(1));
    const q2 = queue.enqueue(() => Promise.resolve(2));
    await expect(queue.enqueue(() => Promise.resolve(3))).rejects.toBeInstanceOf(
      RequestQueueOverflowError,
    );
    await Promise.all([block, q1, q2]);
  });

  it("reset отклоняет ожидающие и освобождает слоты", async () => {
    const queue = new RequestQueue({ concurrency: 1, timeoutMs: 0 });
    const stuck = queue.enqueue(() => new Promise<void>(() => { /* never settles */ }));
    const waiting = queue.enqueue(() => Promise.resolve("never runs"));
    const result = queue.reset();
    expect(result).toEqual({ rejectedPending: 1, clearedRunning: 1 });
    await expect(waiting).rejects.toThrow("сброшена");
    expect(queue.activeCount).toBe(0);
    await expect(queue.enqueue(() => Promise.resolve("ok"))).resolves.toBe("ok");
    void stuck.catch(() => undefined);
  });

  it("синхронный throw внутри операции не утекает слотом", async () => {
    const queue = new RequestQueue({ concurrency: 1, timeoutMs: 0 });
    await expect(
      queue.enqueue(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(queue.activeCount).toBe(0);
    await expect(queue.enqueue(() => Promise.resolve("after"))).resolves.toBe("after");
  });
});
