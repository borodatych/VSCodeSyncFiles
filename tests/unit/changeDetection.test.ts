import { describe, expect, it } from "vitest";
import { detectChange } from "../../src/core/changeDetection.js";

describe("detectChange", () => {
  const base = "bbbb";

  it("нет базы: только локально → push", () => {
    expect(detectChange(undefined, "aaa", "")).toBe("push");
  });

  it("нет изменений (все равны базе через совпадение локального и облака)", () => {
    expect(detectChange(base, base, base)).toBe("none");
  });

  it("локально новее", () => {
    expect(detectChange(base, "local-new", base)).toBe("push");
  });

  it("удалённо новее", () => {
    expect(detectChange(base, base, "cloud-new")).toBe("pull");
  });

  it("локального файла нет, облако как baseline → pull", () => {
    expect(detectChange(base, "", base)).toBe("pull");
  });

  it("конфликт", () => {
    expect(detectChange(base, "L", "C")).toBe("conflict");
  });
});
