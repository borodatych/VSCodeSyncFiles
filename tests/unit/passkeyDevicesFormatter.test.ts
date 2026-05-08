import { describe, expect, it } from "vitest";
import {
  parseDeviceUserAgent,
  renderPasskeyDevicesHtml,
  type PasskeyDeviceEntry,
} from "../../src/core/passkeyDevicesFormatter.js";

const NOW = 1_700_000_000_000;
const UA_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_FIREFOX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
const UA_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0";
const UA_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("parseDeviceUserAgent — browser detection", () => {
  it("detects Chrome on macOS with major version", () => {
    const r = parseDeviceUserAgent(UA_CHROME);
    expect(r.browser).toBe("Chrome");
    expect(r.browserVersion).toBe("124");
    expect(r.os).toBe("macOS");
    expect(r.osVersion).toBe("14.2");
    expect(r.combined).toBe("Chrome 124 on macOS 14.2");
  });

  it("detects Firefox on Linux", () => {
    const r = parseDeviceUserAgent(UA_FIREFOX);
    expect(r.browser).toBe("Firefox");
    expect(r.browserVersion).toBe("120");
    expect(r.os).toBe("Linux");
  });

  it("detects Edge before falling through to Chrome (Edge UA contains 'Chrome')", () => {
    const r = parseDeviceUserAgent(UA_EDGE);
    expect(r.browser).toBe("Edge");
    expect(r.browserVersion).toBe("118");
    expect(r.os).toBe("Windows");
  });

  it("detects Safari on iOS", () => {
    const r = parseDeviceUserAgent(UA_SAFARI);
    expect(r.browser).toBe("Safari");
    expect(r.browserVersion).toBe("17");
    expect(r.os).toBe("iOS");
  });

  it("returns 'Unknown device' for completely unrecognised UA", () => {
    const r = parseDeviceUserAgent("CustomBot/1.0");
    expect(r.browser).toBe("Other");
    expect(r.os).toBe("Other");
    expect(r.combined).toBe("Unknown device");
  });
});

describe("renderPasskeyDevicesHtml — empty state", () => {
  it("renders 'No passkeys enrolled yet.' when devices empty", () => {
    const html = renderPasskeyDevicesHtml([]);
    expect(html).toContain("No passkeys enrolled yet.");
    expect(html).not.toContain('<li class="device-row"');
  });
});

describe("renderPasskeyDevicesHtml — happy path", () => {
  function entry(overrides: Partial<PasskeyDeviceEntry> = {}): PasskeyDeviceEntry {
    return {
      id: "abc123",
      displayName: "Personal MacBook",
      userAgent: UA_CHROME,
      enrolledAtMs: NOW - 30 * 86_400_000,
      lastUsedAtMs: NOW - 86_400_000,
      ...overrides,
    };
  }

  it("renders one row per device with id, name, meta, action buttons", () => {
    const html = renderPasskeyDevicesHtml([entry()]);
    expect(html).toContain('data-id="abc123"');
    expect(html).toContain("Personal MacBook");
    expect(html).toContain("Chrome 124 on macOS 14.2");
    expect(html).toContain('data-action="rename"');
    expect(html).toContain('data-action="remove"');
  });

  it("sorts rows by enrolledAtMs descending", () => {
    const older = entry({ id: "older", displayName: "Old", enrolledAtMs: NOW - 100 * 86_400_000 });
    const newer = entry({ id: "newer", displayName: "New", enrolledAtMs: NOW - 1 * 86_400_000 });
    const html = renderPasskeyDevicesHtml([older, newer]);
    const oldIdx = html.indexOf('data-id="older"');
    const newIdx = html.indexOf('data-id="newer"');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
  });

  it("renders 'never' when lastUsedAtMs is null", () => {
    const html = renderPasskeyDevicesHtml([entry({ lastUsedAtMs: null })]);
    expect(html).toContain("Last used never");
  });

  it("respects a caller-supplied formatDate", () => {
    const html = renderPasskeyDevicesHtml([entry()], {
      formatDate: (ms) => `T+${String(Math.floor(ms / 86_400_000))}d`,
    });
    expect(html).toContain("Enrolled T+");
  });
});

describe("renderPasskeyDevicesHtml — XSS escapes", () => {
  it("escapes <script> tags inside displayName", () => {
    const html = renderPasskeyDevicesHtml([
      {
        id: "x",
        displayName: "<script>alert('xss')</script>",
        userAgent: UA_CHROME,
        enrolledAtMs: NOW,
        lastUsedAtMs: null,
      },
    ]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes \" inside id used in data-id attribute", () => {
    const html = renderPasskeyDevicesHtml([
      {
        id: 'x" onclick="evil',
        displayName: "x",
        userAgent: UA_CHROME,
        enrolledAtMs: NOW,
        lastUsedAtMs: null,
      },
    ]);
    expect(html).not.toContain('"x" onclick="evil"');
    expect(html).toContain("&quot;");
  });

  it("escapes user agent string before rendering", () => {
    const html = renderPasskeyDevicesHtml([
      {
        id: "x",
        displayName: "x",
        userAgent: "<img src=x onerror=alert(1)>",
        enrolledAtMs: NOW,
        lastUsedAtMs: null,
      },
    ]);
    expect(html).not.toContain("<img src=x");
  });
});
