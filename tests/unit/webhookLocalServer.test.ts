import { describe, expect, it } from "vitest";
import { startLocalWebhookServer, WEBHOOK_LOCAL_SERVER_MAX_BODY_BYTES } from "../../src/ui/webhookLocalServer.js";

interface FetchResult {
  status: number;
  body: string;
  headers: Headers;
}

async function fetchJson(url: string, init?: RequestInit): Promise<FetchResult> {
  const r = await fetch(url, init);
  return { status: r.status, body: await r.text(), headers: r.headers };
}

describe("startLocalWebhookServer — bind & dispose", () => {
  it("allocates an ephemeral port when port=0 is requested", async () => {
    const srv = await startLocalWebhookServer({
      handler: () => ({ status: 200, body: "ok" }),
    });
    try {
      expect(srv.port).toBeGreaterThan(0);
      expect(srv.port).toBeLessThan(65536);
    } finally {
      await srv.dispose();
    }
  });

  it("dispose is idempotent", async () => {
    const srv = await startLocalWebhookServer({
      handler: () => ({ status: 200 }),
    });
    await srv.dispose();
    await srv.dispose(); // second dispose must not throw
  });
});

describe("startLocalWebhookServer — request dispatch", () => {
  it("invokes handler with method/url/headers/body and returns its response", async () => {
    const seen: { method: string; url: string; bodyLen: number; headerKeys: string[] } = {
      method: "",
      url: "",
      bodyLen: 0,
      headerKeys: [],
    };
    const srv = await startLocalWebhookServer({
      handler: (req) => {
        seen.method = req.method;
        seen.url = req.url;
        seen.bodyLen = req.body.byteLength;
        seen.headerKeys = Object.keys(req.headers);
        return { status: 201, body: "echo:" + req.body.toString("utf8") };
      },
    });
    try {
      const r = await fetchJson(`http://127.0.0.1:${String(srv.port)}/notify?x=1`, {
        method: "POST",
        headers: { "X-Custom": "value" },
        body: "hello",
      });
      expect(r.status).toBe(201);
      expect(r.body).toBe("echo:hello");
      expect(seen.method).toBe("POST");
      expect(seen.url).toBe("/notify?x=1");
      expect(seen.bodyLen).toBe(5);
      expect(seen.headerKeys).toContain("x-custom");
    } finally {
      await srv.dispose();
    }
  });

  it("rejects POST with declared content-length over max with 413", async () => {
    const srv = await startLocalWebhookServer({
      maxBodyBytes: 100,
      handler: () => ({ status: 200 }),
    });
    try {
      const r = await fetchJson(`http://127.0.0.1:${String(srv.port)}/`, {
        method: "POST",
        headers: { "Content-Length": "9999" },
        body: "x".repeat(9999),
      });
      expect(r.status).toBe(413);
    } finally {
      await srv.dispose();
    }
  });

  it("returns 500 when handler throws", async () => {
    const srv = await startLocalWebhookServer({
      handler: () => {
        throw new Error("boom");
      },
    });
    try {
      const r = await fetch(`http://127.0.0.1:${String(srv.port)}/`);
      expect(r.status).toBe(500);
    } finally {
      await srv.dispose();
    }
  });

  it("uses default body size cap when maxBodyBytes not specified", () => {
    expect(WEBHOOK_LOCAL_SERVER_MAX_BODY_BYTES).toBe(64 * 1024);
  });
});

describe("startLocalWebhookServer — restart cycle", () => {
  it("can dispose-then-start a new server on the same options", async () => {
    const srv1 = await startLocalWebhookServer({
      handler: () => ({ status: 200, body: "first" }),
    });
    const port1 = srv1.port;
    await srv1.dispose();

    const srv2 = await startLocalWebhookServer({
      handler: () => ({ status: 200, body: "second" }),
    });
    try {
      expect(srv2.port).toBeGreaterThan(0);
      // Different ephemeral allocations are fine; primarily we just want the
      // second listener to bind successfully.
      const r = await fetchJson(`http://127.0.0.1:${String(srv2.port)}/`);
      expect(r.body).toBe("second");
      void port1;
    } finally {
      await srv2.dispose();
    }
  });
});
