import { describe, expect, it } from "vitest";
import {
  isValidTunnelUrl,
  scrapeTunnelUrl,
} from "../../src/core/tunnelUrlScrape.js";

describe("scrapeTunnelUrl — cloudflared", () => {
  it("extracts the trycloudflare.com URL from a typical stderr block", () => {
    const stderr = [
      "2024-06-15T12:00:00Z INF Starting tunnel tunnelID=...",
      "2024-06-15T12:00:00Z INF +-------------------------------------------+",
      "2024-06-15T12:00:00Z INF |  https://abc-def-ghi.trycloudflare.com   |",
      "2024-06-15T12:00:00Z INF +-------------------------------------------+",
    ].join("\n");
    expect(scrapeTunnelUrl(stderr, "cloudflared")).toBe(
      "https://abc-def-ghi.trycloudflare.com",
    );
  });

  it("returns null when no trycloudflare URL is present", () => {
    expect(scrapeTunnelUrl("nothing of interest here", "cloudflared")).toBeNull();
  });

  it("returns the first match if multiple URLs are present (last-wins semantics handled by caller)", () => {
    const buf = "first https://aaa.trycloudflare.com second https://bbb.trycloudflare.com";
    expect(scrapeTunnelUrl(buf, "cloudflared")).toBe("https://aaa.trycloudflare.com");
  });

  it("does not match http:// (must be HTTPS)", () => {
    expect(
      scrapeTunnelUrl("http://abc.trycloudflare.com", "cloudflared"),
    ).toBeNull();
  });
});

describe("scrapeTunnelUrl — tailscale-funnel", () => {
  it("extracts the *.ts.net URL from `tailscale funnel status` output", () => {
    const stdout =
      "https://my-machine.tailnet-1234.ts.net/   tcp://127.0.0.1:8000";
    const got = scrapeTunnelUrl(stdout, "tailscale-funnel");
    // Trailing slash is part of the URL token here; the dispatcher accepts both.
    expect(got).toMatch(/^https:\/\/my-machine\.tailnet-1234\.ts\.net\/?$/);
  });

  it("extracts URL even when surrounded by punctuation", () => {
    const stdout = "Funnel on, (https://node-7.tailnet-aaa.ts.net) listening";
    expect(scrapeTunnelUrl(stdout, "tailscale-funnel")).toBe(
      "https://node-7.tailnet-aaa.ts.net",
    );
  });

  it("returns null when funnel ACL is missing", () => {
    const stderr =
      "Error: Funnel is not enabled in this tailnet. See https://tailscale.com/kb/1223/...";
    // The KB URL is not under .ts.net — must not be returned as the funnel URL.
    expect(scrapeTunnelUrl(stderr, "tailscale-funnel")).toBeNull();
  });
});

describe("isValidTunnelUrl", () => {
  it("rejects http://", () => {
    expect(isValidTunnelUrl("http://abc.trycloudflare.com", "cloudflared")).toBe(false);
  });

  it("requires .trycloudflare.com for cloudflared kind", () => {
    expect(isValidTunnelUrl("https://abc.example.com", "cloudflared")).toBe(false);
    expect(isValidTunnelUrl("https://abc.trycloudflare.com", "cloudflared")).toBe(true);
  });

  it("requires .ts.net (with or without trailing slash) for tailscale", () => {
    expect(isValidTunnelUrl("https://node.tailnet.ts.net", "tailscale-funnel")).toBe(true);
    expect(isValidTunnelUrl("https://node.tailnet.ts.net/", "tailscale-funnel")).toBe(true);
    expect(isValidTunnelUrl("https://node.tailnet.example.com", "tailscale-funnel")).toBe(false);
  });
});
