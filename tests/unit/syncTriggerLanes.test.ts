/**
 * Behaviour the single promise chain in `syncTriggerManager` did not have.
 */
import { describe, expect, it } from "vitest";
import { createTriggerLanes } from "../../src/core/syncTriggerLanes.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("createTriggerLanes", () => {
  it("операции одной полосы выполняются последовательно", async () => {
    const lanes = createTriggerLanes();
    const order: string[] = [];
    lanes.run("file", async () => {
      order.push("a:start");
      await delay(20);
      order.push("a:end");
    }, "a");
    lanes.run("file", async () => {
      order.push("b:start");
      await delay(1);
      order.push("b:end");
    }, "b");
    await lanes.idle();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("тяжёлый полный проход не блокирует пофайловую полосу", async () => {
    // The whole point of splitting: a save-triggered push must not wait behind
    // a full pass over every workspace.
    const lanes = createTriggerLanes();
    const order: string[] = [];
    lanes.run("full", async () => {
      order.push("full:start");
      await delay(40);
      order.push("full:end");
    }, "full");
    lanes.run("file", () => {
      order.push("file:done");
      return Promise.resolve();
    }, "file");
    await lanes.idle();
    expect(order.indexOf("file:done")).toBeLessThan(order.indexOf("full:end"));
  });

  it("повторные полные проходы схлопываются, а не накапливаются", async () => {
    const lanes = createTriggerLanes();
    let runs = 0;
    for (let i = 0; i < 10; i += 1) {
      lanes.run("full", async () => {
        runs += 1;
        await delay(5);
      }, `focus-${String(i)}`);
    }
    await lanes.idle();
    expect(runs).toBe(1);
    expect(lanes.skippedFullCount).toBe(9);
  });

  it("шаг, который никогда не завершается, освобождает полосу по дедлайну", async () => {
    // The old chain had no deadline: such a step froze every later trigger for
    // the lifetime of the window.
    const timeouts: string[] = [];
    const lanes = createTriggerLanes({
      stepTimeoutMs: 20,
      onStepTimeout: (label) => timeouts.push(label),
    });
    let secondRan = false;
    lanes.run("file", () => new Promise<void>(() => { /* never settles */ }), "wedged");
    lanes.run("file", () => {
      secondRan = true;
      return Promise.resolve();
    }, "after");
    await lanes.idle();
    expect(timeouts).toEqual(["wedged"]);
    expect(lanes.timedOutCount).toBe(1);
    expect(secondRan).toBe(true);
  });

  it("отклонённый шаг не рвёт полосу", async () => {
    const errors: string[] = [];
    const lanes = createTriggerLanes({ onStepError: (label) => errors.push(label) });
    let secondRan = false;
    lanes.run("file", () => Promise.reject(new Error("boom")), "bad");
    lanes.run("file", () => {
      secondRan = true;
      return Promise.resolve();
    }, "good");
    await lanes.idle();
    expect(errors).toEqual(["bad"]);
    expect(secondRan).toBe(true);
  });

  it("синхронный throw внутри шага не рвёт полосу", async () => {
    const errors: string[] = [];
    const lanes = createTriggerLanes({ onStepError: (label) => errors.push(label) });
    let secondRan = false;
    lanes.run("file", () => {
      throw new Error("sync boom");
    }, "throwing");
    lanes.run("file", () => {
      secondRan = true;
      return Promise.resolve();
    }, "good");
    await lanes.idle();
    expect(errors).toEqual(["throwing"]);
    expect(secondRan).toBe(true);
  });

  it("после завершения полного прохода можно запустить следующий", async () => {
    const lanes = createTriggerLanes();
    let runs = 0;
    lanes.run("full", () => {
      runs += 1;
      return Promise.resolve();
    }, "first");
    await lanes.idle();
    lanes.run("full", () => {
      runs += 1;
      return Promise.resolve();
    }, "second");
    await lanes.idle();
    expect(runs).toBe(2);
    expect(lanes.skippedFullCount).toBe(0);
  });
});
