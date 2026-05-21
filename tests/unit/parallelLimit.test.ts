import { describe, expect, it, vi } from "vitest";
import {
  parallelLimit,
  parallelLimitSettle,
} from "../../src/core/parallelLimit.js";

describe("parallelLimit", () => {
  it("preserves input order", async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await parallelLimit(items, (n) => Promise.resolve(n * 10), { concurrency: 3 });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await parallelLimit(
      items,
      async () => {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
      { concurrency: 4 },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("fails fast on the first rejection", async () => {
    const seen: number[] = [];
    await expect(
      parallelLimit(
        [1, 2, 3, 4, 5, 6],
        async (n) => {
          seen.push(n);
          await new Promise((r) => setTimeout(r, 1));
          if (n === 2) throw new Error("boom");
        },
        { concurrency: 2 },
      ),
    ).rejects.toThrow("boom");
    // We didn't burn through the whole list after the failure.
    expect(seen.length).toBeLessThan(6);
  });

  it("returns [] for empty input without invoking the worker", async () => {
    const worker = vi.fn();
    const out = await parallelLimit<number, number>([], worker, { concurrency: 4 });
    expect(out).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it("clamps concurrency to [1, items.length]", async () => {
    const items = [1, 2, 3];
    const out = await parallelLimit(items, (n) => Promise.resolve(n), { concurrency: 0 });
    expect(out).toEqual([1, 2, 3]);
    const out2 = await parallelLimit(items, (n) => Promise.resolve(n), { concurrency: 999 });
    expect(out2).toEqual([1, 2, 3]);
  });

  it("reports progress monotonically", async () => {
    const seen: number[] = [];
    await parallelLimit(
      [1, 2, 3, 4],
      (n) => Promise.resolve(n),
      {
        concurrency: 2,
        onProgress: (settled, total) => {
          expect(total).toBe(4);
          seen.push(settled);
        },
      },
    );
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

describe("parallelLimitSettle", () => {
  it("captures both successes and rejections in order", async () => {
    const out = await parallelLimitSettle(
      [1, 2, 3, 4],
      (n) => {
        if (n === 2) return Promise.reject(new Error("two"));
        return Promise.resolve(n * 10);
      },
      { concurrency: 2 },
    );
    expect(out).toEqual([
      { ok: true, value: 10 },
      { ok: false, error: new Error("two") },
      { ok: true, value: 30 },
      { ok: true, value: 40 },
    ]);
  });

  it("never throws", async () => {
    const out = await parallelLimitSettle(
      [1, 2, 3],
      () => Promise.reject(new Error("nope")),
      { concurrency: 2 },
    );
    expect(out.every((r) => !r.ok)).toBe(true);
  });
});
