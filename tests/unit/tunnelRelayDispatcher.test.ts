import { describe, expect, it, vi } from "vitest";
import { createAndStartTunnelRelay } from "../../src/ui/tunnelRelayDispatcher.js";
import type { SmeePayload, SmeeRelay } from "../../src/ui/webhookTunnel.js";
import type {
  TunnelOpenResult,
  TunnelProviderType,
} from "../../src/ui/tunnelProviderRegistry.js";
import type { LocalWebhookServer, WebhookHandler } from "../../src/ui/webhookLocalServer.js";

function fakeSmeeRelay(channelUrl = "https://smee.io/abc"): SmeeRelay {
  return { channelUrl, dispose: vi.fn() };
}

function fakeLocalServer(): { server: LocalWebhookServer; handler: { current?: WebhookHandler } } {
  const handlerRef: { current?: WebhookHandler } = {};
  const dispose = vi.fn(() => Promise.resolve());
  const server: LocalWebhookServer = { port: 12345, dispose };
  return { server, handler: handlerRef };
}

describe("createAndStartTunnelRelay — smee path", () => {
  it("uses smee directly when setting === 'smee'", async () => {
    const smee = fakeSmeeRelay("https://smee.io/CH");
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: "smee",
      handler: () => undefined,
      smeeRelayOverride: () => Promise.resolve(smee),
    });
    expect(out?.provider).toBe("smee");
    expect(out?.publicUrl).toBe("https://smee.io/CH");
  });

  it("treats undefined / unknown setting as smee", async () => {
    const smee = fakeSmeeRelay();
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: undefined,
      handler: () => undefined,
      smeeRelayOverride: () => Promise.resolve(smee),
    });
    expect(out?.provider).toBe("smee");
  });
});

describe("createAndStartTunnelRelay — tunnel path success", () => {
  it("opens the requested tunnel backend and returns its public URL", async () => {
    const { server, handler } = fakeLocalServer();
    const dispose = vi.fn(() => Promise.resolve());
    const opener = vi.fn<typeof import("../../src/ui/tunnelProviderRegistry.js").openTunnel>(
      (type: TunnelProviderType): Promise<TunnelOpenResult> =>
        Promise.resolve({
          ok: true,
          channel: {
            publicUrl: `https://${type}.example.com`,
            provider: type,
            dispose,
          },
        }),
    );
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: "cloudflared",
      handler: () => undefined,
      openTunnelOverride: opener,
      localServerFactory: (opts) => {
        handler.current = opts.handler;
        return Promise.resolve(server);
      },
    });
    expect(out?.provider).toBe("cloudflared");
    expect(out?.publicUrl).toBe("https://cloudflared.example.com");
    expect(opener).toHaveBeenCalledWith("cloudflared", 12345);

    await out?.dispose();
    expect(dispose).toHaveBeenCalled();
    expect(server.dispose).toHaveBeenCalled();
  });
});

describe("createAndStartTunnelRelay — tunnel path failure → smee fallback", () => {
  it("falls back to smee when openTunnel returns not_available", async () => {
    const smee = fakeSmeeRelay("https://smee.io/FALLBACK");
    const opener = vi.fn(
      (): Promise<TunnelOpenResult> =>
        Promise.resolve({ ok: false, reason: "not_available", detail: "no binary" }),
    );
    const { server } = fakeLocalServer();
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: "cloudflared",
      handler: () => undefined,
      openTunnelOverride: opener,
      localServerFactory: () => Promise.resolve(server),
      smeeRelayOverride: () => Promise.resolve(smee),
    });
    expect(out?.provider).toBe("smee");
    expect(out?.publicUrl).toBe("https://smee.io/FALLBACK");
    expect(server.dispose).toHaveBeenCalled();
  });

  it("returns undefined when openTunnel fails AND noFallback=true", async () => {
    const opener = (): Promise<TunnelOpenResult> =>
      Promise.resolve({ ok: false, reason: "spawn_failed" });
    const { server } = fakeLocalServer();
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: "tailscale-funnel",
      handler: () => undefined,
      openTunnelOverride: opener,
      localServerFactory: () => Promise.resolve(server),
      noFallback: true,
    });
    expect(out).toBeUndefined();
  });

  it("falls back to smee when local server fails to bind", async () => {
    const smee = fakeSmeeRelay();
    const out = await createAndStartTunnelRelay({
      rawProviderSetting: "cloudflared",
      handler: () => undefined,
      localServerFactory: () => Promise.reject(new Error("EADDRINUSE")),
      smeeRelayOverride: () => Promise.resolve(smee),
    });
    expect(out?.provider).toBe("smee");
  });
});

describe("createAndStartTunnelRelay — handler dispatch via local server", () => {
  it("converts incoming POST JSON into SmeePayload shape", async () => {
    const { server, handler } = fakeLocalServer();
    const opener = (): Promise<TunnelOpenResult> =>
      Promise.resolve({
        ok: true,
        channel: {
          publicUrl: "https://x.example",
          provider: "cloudflared",
          dispose: () => Promise.resolve(),
        },
      });
    const seen: SmeePayload[] = [];
    await createAndStartTunnelRelay({
      rawProviderSetting: "cloudflared",
      handler: (p) => seen.push(p),
      openTunnelOverride: opener,
      localServerFactory: (opts) => {
        handler.current = opts.handler;
        return Promise.resolve(server);
      },
    });
    const cb = handler.current;
    if (!cb) throw new Error("handler not captured");
    const resp = await cb({
      method: "POST",
      url: "/",
      headers: { "x-github-event": "push" },
      body: Buffer.from(JSON.stringify({ a: 1 }), "utf8"),
    });
    expect(resp.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({ a: 1 });
    expect(seen[0]?.headers["x-github-event"]).toBe("push");
  });

  it("rejects non-POST requests with 405", async () => {
    const { server, handler } = fakeLocalServer();
    const opener = (): Promise<TunnelOpenResult> =>
      Promise.resolve({
        ok: true,
        channel: {
          publicUrl: "https://x.example",
          provider: "cloudflared",
          dispose: () => Promise.resolve(),
        },
      });
    await createAndStartTunnelRelay({
      rawProviderSetting: "cloudflared",
      handler: () => undefined,
      openTunnelOverride: opener,
      localServerFactory: (opts) => {
        handler.current = opts.handler;
        return Promise.resolve(server);
      },
    });
    const cb = handler.current;
    if (!cb) throw new Error("handler not captured");
    const resp = await cb({ method: "GET", url: "/", headers: {}, body: Buffer.alloc(0) });
    expect(resp.status).toBe(405);
  });
});
