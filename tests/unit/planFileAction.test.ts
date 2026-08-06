/**
 * Matrix for the one decision function (C17). No mocks: hashes in, verdict out.
 */
import { describe, expect, it } from "vitest";
import {
  planFileAction,
  syncStatusForAction,
  type FileActionInput,
} from "../../src/core/plan/planFileAction.js";

const A = "hash-A";
const B = "hash-B";
const C = "hash-C";

const plan = (i: Partial<FileActionInput>): ReturnType<typeof planFileAction> =>
  planFileAction({ baseHash: A, cachedLocalHash: A, localHash: A, cloudHash: A, ...i });

describe("planFileAction — базовая матрица", () => {
  it("всё совпадает → none", () => {
    expect(plan({}).action).toBe("none");
  });

  it("локальный изменён, облако на базе → push", () => {
    expect(plan({ cachedLocalHash: A, localHash: B, cloudHash: A }).action).toBe("push");
  });

  it("облако изменено, локальный на базе → pull", () => {
    expect(plan({ localHash: A, cloudHash: B }).action).toBe("pull");
  });

  it("обе стороны разошлись от базы → conflict", () => {
    expect(plan({ cachedLocalHash: B, localHash: B, cloudHash: C }).action).toBe("conflict");
  });

  it("нет базы: файла нет в облаке → push; локального нет → pull", () => {
    expect(plan({ baseHash: undefined, cachedLocalHash: "", localHash: B, cloudHash: "" }).action).toBe(
      "push",
    );
    expect(plan({ baseHash: undefined, cachedLocalHash: "", localHash: "", cloudHash: B }).action).toBe(
      "pull",
    );
  });
});

describe("planFileAction — отставание кэша от консенсуса", () => {
  it("кэш отстал, облако на базе, содержимое РАЗНОЕ → pull с причиной consensus_lag", () => {
    // Другая машина двинула `_meta`; наш localHash устарел. Наивная 3-way
    // сверка сказала бы «push» и затёрла бы их версию.
    const r = plan({ baseHash: B, cachedLocalHash: A, localHash: C, cloudHash: B });
    expect(r).toEqual({ action: "pull", reason: "consensus_lag" });
  });

  it("кэш отстал, но локальное содержимое РАВНО облачному → none (это и был C17)", () => {
    // Файл правили и вернули к исходному. Три из четырёх прежних мест
    // отвечали здесь «pull», а панель показывала «↓1», которое ничего не тянет.
    const r = plan({ baseHash: B, cachedLocalHash: A, localHash: B, cloudHash: B });
    expect(r).toEqual({ action: "none", reason: "three_way" });
  });

  it("пустая база не включает страховку", () => {
    expect(plan({ baseHash: "", cachedLocalHash: A, localHash: C, cloudHash: "" }).reason).toBe(
      "three_way",
    );
  });

  it("облако ушло от базы — страховка не применяется, решает 3-way", () => {
    const r = plan({ baseHash: B, cachedLocalHash: A, localHash: C, cloudHash: A });
    expect(r.reason).toBe("three_way");
    expect(r.action).toBe("conflict");
  });
});

describe("syncStatusForAction", () => {
  it("отображение действия в статус", () => {
    expect(syncStatusForAction("push")).toBe("pending_push");
    expect(syncStatusForAction("pull")).toBe("cloud_newer");
    expect(syncStatusForAction("none")).toBe("ok");
    expect(syncStatusForAction("conflict")).toBe("conflict");
  });
});
