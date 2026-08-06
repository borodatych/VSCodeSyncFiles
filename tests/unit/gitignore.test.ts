import { describe, expect, it } from "vitest";
import {
  buildGitignoreAppend,
  gitignoreCoversVscodesync,
} from "../../src/ui/workspaceGitignore.js";

describe("workspaceGitignore", () => {
  it("gitignoreCoversVscodesync распознаёт .vscode/", () => {
    expect(gitignoreCoversVscodesync("\n.vscode/\n")).toBe(true);
    expect(gitignoreCoversVscodesync(".vscode/vscodesync.json\n")).toBe(true);
    expect(gitignoreCoversVscodesync("*.log\n")).toBe(false);
  });

  it("buildGitignoreAppend добавляет запись", () => {
    const r = buildGitignoreAppend("foo\n");
    expect(r.includes(".vscode/vscodesync.json")).toBe(true);
  });
});
