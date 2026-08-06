import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { aiMergePreviewPath, summarizeAiMergeDiff } from "../../src/core/aiMergePlan.js";

describe("aiMergePreviewPath", () => {
  const now = Date.parse("2026-08-06T10:20:30.000Z");

  it("ставит метку времени перед расширением внутри папки бэкапов", () => {
    expect(aiMergePreviewPath("/w", ".vscode/backup", "src/app.ts", now)).toBe(
      path.join("/w", ".vscode/backup", ".ai-merge", "app.ai-2026-08-06T10-20-30Z.ts"),
    );
  });

  it("файл без расширения не получает пустую точку", () => {
    expect(aiMergePreviewPath("/w", ".b", "LICENSE", now)).toBe(
      path.join("/w", ".b", ".ai-merge", "LICENSE.ai-2026-08-06T10-20-30Z"),
    );
  });
});

describe("summarizeAiMergeDiff", () => {
  it("одинаковый текст → identical", () => {
    expect(summarizeAiMergeDiff("a\nb", "a\nb")).toEqual({
      addedLines: 0,
      removedLines: 0,
      identical: true,
    });
  });

  it("считает добавленные и удалённые строки", () => {
    expect(summarizeAiMergeDiff("a\nb\nc", "a\nc\nd\ne")).toEqual({
      addedLines: 2,
      removedLines: 1,
      identical: false,
    });
  });

  it("перестановка строк не считается изменением объёма", () => {
    expect(summarizeAiMergeDiff("a\nb\nc", "c\nb\na")).toEqual({
      addedLines: 0,
      removedLines: 0,
      identical: false,
    });
  });

  it("повторяющиеся строки учитываются как мультимножество", () => {
    expect(summarizeAiMergeDiff("a\na\na", "a")).toEqual({
      addedLines: 0,
      removedLines: 2,
      identical: false,
    });
  });
});
