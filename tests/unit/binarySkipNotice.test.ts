/**
 * `warnOnBinaryFiles` promises a warning; the automatic paths only ever
 * returned. A tracked binary file was never pushed by automation — for the
 * lifetime of the workspace — with no status, no notification and nothing in
 * the log, which is indistinguishable from "sync is broken".
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  binarySkipMessage,
  clearBinarySkipNotice,
  resetBinarySkipNotices,
  shouldAnnounceBinarySkip,
} from "../../src/core/binarySkipNotice.js";

beforeEach(() => {
  resetBinarySkipNotices();
});

describe("shouldAnnounceBinarySkip", () => {
  it("первый пропуск файла объявляется", () => {
    expect(shouldAnnounceBinarySkip("/repo", "assets/logo.png")).toBe(true);
  });

  it("повторные пропуски молчат — цикл сохранений не превращается в шторм", () => {
    shouldAnnounceBinarySkip("/repo", "assets/logo.png");
    expect(shouldAnnounceBinarySkip("/repo", "assets/logo.png")).toBe(false);
    expect(shouldAnnounceBinarySkip("/repo", "assets/logo.png")).toBe(false);
  });

  it("разные файлы объявляются независимо", () => {
    expect(shouldAnnounceBinarySkip("/repo", "a.png")).toBe(true);
    expect(shouldAnnounceBinarySkip("/repo", "b.png")).toBe(true);
  });

  it("разные корни не мешают друг другу", () => {
    expect(shouldAnnounceBinarySkip("/repo-one", "a.png")).toBe(true);
    expect(shouldAnnounceBinarySkip("/repo-two", "a.png")).toBe(true);
  });

  it("написание корня не влияет — Windows-разделители и регистр", () => {
    expect(shouldAnnounceBinarySkip("C:/Repo", "A.png")).toBe(true);
    expect(shouldAnnounceBinarySkip("C:\\repo", "a.png")).toBe(false);
  });

  it("после явного push файл снова объявляется при пропуске", () => {
    shouldAnnounceBinarySkip("/repo", "a.png");
    clearBinarySkipNotice("/repo", "a.png");
    expect(shouldAnnounceBinarySkip("/repo", "a.png")).toBe(true);
  });
});

describe("binarySkipMessage", () => {
  it("называет файл, настройку и способ обойти", () => {
    const msg = binarySkipMessage("assets/logo.png");
    expect(msg).toContain("assets/logo.png");
    expect(msg).toContain("warnOnBinaryFiles");
    expect(msg).toContain("Push");
  });
});
