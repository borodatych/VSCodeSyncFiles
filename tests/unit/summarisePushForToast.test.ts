/**
 * The push toast must describe what actually happened.
 *
 * Commands announced a flat "Push …: готово." no matter the outcome: zero files
 * sent, files skipped, whole workspaces failed — all of it read as success.
 * That is the "it says done but nothing was uploaded" complaint.
 */
import { describe, expect, it } from "vitest";
import { summarisePushForToast } from "../../src/core/bulkPushWizard.js";
import type { PushAllResult } from "../../src/core/syncEngine.js";

const ok = (pushedFiles: number, extra: Partial<PushAllResult> = {}): PushAllResult => ({
  workspaceId: "ws",
  ok: true,
  pushedFiles,
  ...extra,
});

describe("summarisePushForToast", () => {
  it("ноль отправленных не выдаётся за успех", () => {
    const msg = summarisePushForToast("Push all", [ok(0)]);
    expect(msg).toContain("отправлять было нечего");
    expect(msg).not.toContain("готово");
  });

  it("называет число отправленных файлов", () => {
    expect(summarisePushForToast("Push all", [ok(3)])).toContain("отправлено файлов: 3");
  });

  it("суммирует по всем воркспейсам", () => {
    expect(summarisePushForToast("Push all", [ok(2), ok(5)])).toContain("отправлено файлов: 7");
  });

  it("пропущенные файлы попадают в сообщение", () => {
    const msg = summarisePushForToast("Push all", [
      ok(2, { failedFiles: [{ posixRel: "a.bin", error: "ENOENT" }] }),
    ]);
    expect(msg).toContain("пропущено файлов: 1");
    expect(msg).toContain("Diagnostics");
  });

  it("упавшие воркспейсы попадают в сообщение", () => {
    const msg = summarisePushForToast("Push all", [
      ok(1),
      { workspaceId: "bad", ok: false, pushedFiles: 0, error: "boom" },
    ]);
    expect(msg).toContain("ошибок в папках: 1");
  });

  it("при полном успехе лишних оговорок нет", () => {
    const msg = summarisePushForToast("Push workspace", [ok(4)]);
    expect(msg).toBe("Push workspace: отправлено файлов: 4.");
  });

  it("метка попадает в начало", () => {
    expect(summarisePushForToast("Push workspace (заметки)", [ok(1)])).toMatch(
      /^Push workspace \(заметки\): /,
    );
  });
});
