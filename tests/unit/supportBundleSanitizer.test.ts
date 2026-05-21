import { describe, expect, it } from "vitest";
import {
  buildSupportBundleManifest,
  redactSettings,
  redactString,
} from "../../src/core/supportBundleSanitizer.js";

describe("redactString", () => {
  it("redacts URL token params", () => {
    expect(redactString("https://api.example/path?token=abc123&other=x"))
      .toBe("https://api.example/path?token=<redacted>&other=x");
  });

  it("redacts Bearer tokens", () => {
    expect(redactString("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.foo.bar"))
      .toContain("Bearer <redacted>");
  });

  it("redacts emails by default", () => {
    expect(redactString("user alice@example.com pushed")).toBe("user <email> pushed");
  });

  it("keeps emails when redactEmails=false", () => {
    expect(redactString("alice@example.com", { redactEmails: false })).toBe("alice@example.com");
  });

  it("redacts UUIDs by default", () => {
    expect(redactString("machine 12345678-1234-1234-1234-123456789abc online"))
      .toBe("machine <uuid> online");
  });

  it("redacts long opaque base64 strings", () => {
    const long = "a".repeat(60);
    expect(redactString(long)).toBe("<redacted>");
  });

  it("does not redact short normal text", () => {
    expect(redactString("hello world this is fine")).toBe("hello world this is fine");
  });
});

describe("redactSettings", () => {
  it("redacts secret-like keys regardless of value", () => {
    const out = redactSettings({
      token: "x",
      apiKey: "y",
      "client-secret": "z",
      safeField: "hello",
    });
    expect(out.token).toBe("<redacted>");
    expect(out.apiKey).toBe("<redacted>");
    expect(out["client-secret"]).toBe("<redacted>");
    expect(out.safeField).toBe("hello");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactSettings({
      providers: {
        gdrive: { clientId: "short", refreshToken: "secret-stuff" },
      },
      tags: ["plain", "alice@example.com"],
    });
    const p = out.providers as { gdrive: { clientId: unknown; refreshToken: unknown } };
    expect(p.gdrive.refreshToken).toBe("<redacted>");
    expect(p.gdrive.clientId).toBe("short");
    const tags = out.tags as string[];
    expect(tags[1]).toBe("<email>");
  });

  it("preserves primitives", () => {
    const out = redactSettings({ enabled: true, count: 42, missing: null });
    expect(out.enabled).toBe(true);
    expect(out.count).toBe(42);
    expect(out.missing).toBeNull();
  });
});

describe("buildSupportBundleManifest", () => {
  it("includes platform + provider", () => {
    const m = buildSupportBundleManifest(
      {
        vscodeVersion: "1.99",
        extensionVersion: "0.7.0",
        platform: "win32",
        activeProvider: "onedrive",
        activityEntriesCount: 12,
        healthReportLineCount: 30,
        profileSampleCount: 5,
      },
      "2026-05-21T00:00:00.000Z",
    );
    expect(m.generatedAtIso).toBe("2026-05-21T00:00:00.000Z");
    expect(m.activeProvider).toBe("onedrive");
    expect(m.contents.find((c) => c.name === "activity.last7d.json")?.itemCount).toBe(12);
  });

  it("nulls provider when undefined", () => {
    const m = buildSupportBundleManifest({
      vscodeVersion: "x",
      extensionVersion: "y",
      platform: "linux",
      activityEntriesCount: 0,
      healthReportLineCount: 0,
      profileSampleCount: 0,
    });
    expect(m.activeProvider).toBeNull();
  });
});
