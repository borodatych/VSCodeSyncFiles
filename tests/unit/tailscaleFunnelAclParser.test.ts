import { describe, expect, it } from "vitest";
import { parseTailscaleFunnelStatus } from "../../src/core/tailscaleFunnelAclParser.js";

describe("parseTailscaleFunnelStatus — funnel ON", () => {
  it("extracts a single listening URL", () => {
    const out = `# Funnel on:\n# - https://my-machine.tailnet-1234.ts.net (tcp:443)\n`;
    const r = parseTailscaleFunnelStatus(out);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    if (!r.enabled) throw new Error();
    expect(r.listeningUrls).toEqual(["https://my-machine.tailnet-1234.ts.net"]);
  });

  it("dedupes when the same URL appears twice", () => {
    const out = `# https://m.t.ts.net (tcp:443)\nhttps://m.t.ts.net (tcp:443)\n`;
    const r = parseTailscaleFunnelStatus(out);
    if (!r.ok) throw new Error();
    if (!r.enabled) throw new Error();
    expect(r.listeningUrls).toEqual(["https://m.t.ts.net"]);
  });

  it("captures multiple distinct URLs (port mapped)", () => {
    const out =
      "# https://alpha.tailnet-1234.ts.net (tcp:443)\n" +
      "# https://beta.tailnet-1234.ts.net  (tcp:8443)\n";
    const r = parseTailscaleFunnelStatus(out);
    if (!r.ok) throw new Error();
    if (!r.enabled) throw new Error();
    expect(r.listeningUrls.length).toBe(2);
  });
});

describe("parseTailscaleFunnelStatus — funnel OFF", () => {
  it("recognises the canonical 'Funnel is off' line", () => {
    const r = parseTailscaleFunnelStatus("# Funnel is off");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.enabled).toBe(false);
  });

  it("recognises 'funnel disabled'", () => {
    const r = parseTailscaleFunnelStatus("Funnel disabled for this tailnet");
    if (!r.ok) throw new Error();
    expect(r.enabled).toBe(false);
  });
});

describe("parseTailscaleFunnelStatus — ACL denial", () => {
  it("reports acl_denied for 'forbidden by tailnet policy'", () => {
    const r = parseTailscaleFunnelStatus("funnel is forbidden by tailnet policy");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("acl_denied");
    expect(r.hint).toContain("ACL");
  });

  it("reports acl_denied for 'do not have access to use the Funnel feature'", () => {
    const r = parseTailscaleFunnelStatus("you do not have access to use the Funnel feature");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("acl_denied");
  });

  it("reports acl_denied for 'not in ACL' phrasing", () => {
    const r = parseTailscaleFunnelStatus('"funnel" not in ACL');
    if (r.ok) throw new Error();
    expect(r.reason).toBe("acl_denied");
  });
});

describe("parseTailscaleFunnelStatus — auth + daemon", () => {
  it("reports not_logged_in", () => {
    const r = parseTailscaleFunnelStatus("not logged in. Run `tailscale up`");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("not_logged_in");
  });

  it("reports daemon_unavailable when daemon socket missing", () => {
    const r = parseTailscaleFunnelStatus("failed to connect to local tailscaled");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("daemon_unavailable");
  });

  it("daemon_unavailable wins over not_logged_in if both phrases present", () => {
    const r = parseTailscaleFunnelStatus(
      "could not connect to tailscaled\nplease run `tailscale up`",
    );
    if (r.ok) throw new Error();
    expect(r.reason).toBe("daemon_unavailable");
  });
});

describe("parseTailscaleFunnelStatus — fallback paths", () => {
  it("returns unknown for empty output", () => {
    const r = parseTailscaleFunnelStatus("");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("unknown");
  });

  it("returns unknown for unrecognised gibberish", () => {
    const r = parseTailscaleFunnelStatus("zzzz unrelated output xxxx");
    if (r.ok) throw new Error();
    expect(r.reason).toBe("unknown");
  });
});
