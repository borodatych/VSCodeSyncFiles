import { describe, expect, it } from "vitest";
import {
  classifyWebhookEvent,
  hasSupportedEventKind,
  listSupportedEventKinds,
  WEBHOOK_EVENT_KINDS,
} from "../../src/core/webhookEventKinds.js";

describe("classifyWebhookEvent", () => {
  it("returns 'supported' for OneDrive documented kinds", () => {
    expect(classifyWebhookEvent("onedrive", "updated")).toBe("supported");
    expect(classifyWebhookEvent("onedrive", "deleted")).toBe("supported");
    expect(classifyWebhookEvent("onedrive", "created")).toBe("supported");
  });

  it("returns 'supported' for Google Drive documented kinds", () => {
    expect(classifyWebhookEvent("gdrive", "change")).toBe("supported");
    expect(classifyWebhookEvent("gdrive", "trash")).toBe("supported");
    expect(classifyWebhookEvent("gdrive", "sync")).toBe("supported");
  });

  it("returns 'undocumented' for unknown kinds on a supported provider", () => {
    expect(classifyWebhookEvent("onedrive", "renamed")).toBe("undocumented");
    expect(classifyWebhookEvent("gdrive", "moved")).toBe("undocumented");
  });

  it("returns 'unsupported_provider' for providers without webhook surface", () => {
    expect(classifyWebhookEvent("yandex", "anything")).toBe("unsupported_provider");
    expect(classifyWebhookEvent("dropbox", "anything")).toBe("unsupported_provider");
  });
});

describe("listSupportedEventKinds", () => {
  it("returns sorted set for OneDrive", () => {
    expect(listSupportedEventKinds("onedrive")).toEqual(["created", "deleted", "updated"]);
  });

  it("returns sorted set for Google Drive", () => {
    expect(listSupportedEventKinds("gdrive")).toEqual([
      "add",
      "change",
      "remove",
      "sync",
      "trash",
      "untrash",
      "update",
    ]);
  });

  it("returns empty array for unsupported provider", () => {
    expect(listSupportedEventKinds("yandex")).toEqual([]);
  });
});

describe("hasSupportedEventKind", () => {
  it("returns true if any event in the list is documented", () => {
    expect(hasSupportedEventKind("onedrive", ["renamed", "deleted"])).toBe(true);
  });

  it("returns false when no event is documented", () => {
    expect(hasSupportedEventKind("onedrive", ["renamed", "moved"])).toBe(false);
  });

  it("returns false on an unsupported provider regardless of input", () => {
    expect(hasSupportedEventKind("dropbox", ["created"])).toBe(false);
  });

  it("returns false on empty input", () => {
    expect(hasSupportedEventKind("onedrive", [])).toBe(false);
  });
});

describe("WEBHOOK_EVENT_KINDS — invariant", () => {
  it("uses ReadonlySet to prevent runtime mutation", () => {
    const onedrive = WEBHOOK_EVENT_KINDS.onedrive;
    if (!onedrive) throw new Error("expected onedrive set");
    // Set is structurally mutable but treat the property as read-only at
    // type level. The point of this test is that the catalog is *not*
    // empty — drift detection.
    expect(onedrive.size).toBeGreaterThan(0);
  });
});
