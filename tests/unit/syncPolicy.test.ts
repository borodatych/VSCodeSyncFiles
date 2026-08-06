/**
 * The mutation policy itself (finding F2) — a pure decision, tested as one.
 *
 * The matrix is exhaustive by construction: every operation in `MutationOp` is
 * checked against both triggers, so an operation added to the union without a
 * thought about background behaviour cannot slip through with untested
 * semantics.
 */
import { describe, expect, it } from "vitest";
import {
  MUTATION_OPS,
  MutationDeniedError,
  assertMutationAllowed,
  mutationPolicy,
  type MutationOp,
  type SyncTrigger,
} from "../../src/core/syncPolicy.js";

const TRIGGERS: readonly SyncTrigger[] = ["user", "auto"];

describe("mutationPolicy", () => {
  it("разрешает пользователю каждую операцию из MutationOp", () => {
    const denied = MUTATION_OPS.filter((op) => mutationPolicy(op, "user") !== "allow");
    expect(denied).toEqual([]);
  });

  it("отклоняет автоматическому источнику каждую операцию из MutationOp", () => {
    const allowed = MUTATION_OPS.filter((op) => mutationPolicy(op, "auto") !== "deny");
    expect(allowed).toEqual([]);
  });

  it("решение зависит только от триггера, но проверено на всей матрице", () => {
    const matrix = TRIGGERS.flatMap((trigger) =>
      MUTATION_OPS.map((op) => `${op}:${trigger}=${mutationPolicy(op, trigger)}`),
    );
    expect(matrix).toHaveLength(MUTATION_OPS.length * TRIGGERS.length);
    expect(matrix.filter((r) => r.endsWith("=deny"))).toHaveLength(MUTATION_OPS.length);
  });
});

describe("assertMutationAllowed", () => {
  it("молча пропускает пользовательскую операцию", () => {
    expect(() => {
      assertMutationAllowed("pushFile", "user");
    }).not.toThrow();
  });

  it("бросает MutationDeniedError с операцией и триггером", () => {
    let caught: unknown;
    try {
      assertMutationAllowed("pushAll", "auto");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MutationDeniedError);
    const err = caught as MutationDeniedError;
    expect(err.op).toBe("pushAll");
    expect(err.trigger).toBe("auto");
    expect(err.name).toBe("MutationDeniedError");
  });

  it("сообщение отказа называет операцию и ведёт в панель «Расхождения»", () => {
    const err = new MutationDeniedError("pullFile" satisfies MutationOp, "auto");
    expect(err.message).toContain("pullFile");
    expect(err.message).toContain("Расхождения");
  });
});
