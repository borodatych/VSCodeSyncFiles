import * as http from "node:http";
import { describe, expect, it } from "vitest";
import { startGraphWebhookLocalServer } from "../../src/ui/graphWebhookLocalServer.js";

describe("graphWebhookLocalServer", () => {
  it("responds to validation GET with plaintext token", async () => {
    const srv = await startGraphWebhookLocalServer({
      port: 0,
      graphClientState: "abc",
      onDriveChangeHint: () => {},
    });
    try {
      const token = "hello-validation";
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: srv.port,
            path: `/hook?validationToken=${encodeURIComponent(token)}`,
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            res.on("end", () => {
              resolve(Buffer.concat(chunks).toString("utf8"));
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe(token);
    } finally {
      srv.close();
    }
  });

  it("POST notification invokes hint when clientState matches", async () => {
    let n = 0;
    const srv = await startGraphWebhookLocalServer({
      port: 0,
      graphClientState: "secret",
      onDriveChangeHint: () => {
        n += 1;
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: srv.port,
            path: "/notify",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            res.resume();
            res.on("end", () => {
              resolve();
            });
          },
        );
        req.on("error", reject);
        req.write(JSON.stringify({ value: [{ clientState: "secret" }] }));
        req.end();
      });
      expect(n).toBe(1);
    } finally {
      srv.close();
    }
  });

  it("POST with X-Goog-Channel-Token invokes hint when token matches", async () => {
    let n = 0;
    const tok = "gdrive-channel-secret";
    const srv = await startGraphWebhookLocalServer({
      port: 0,
      graphClientState: "x",
      googleChannelToken: tok,
      onDriveChangeHint: () => {
        n += 1;
      },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: srv.port,
            path: "/gd",
            method: "POST",
            headers: { "X-Goog-Channel-Token": tok },
          },
          (res) => {
            res.resume();
            res.on("end", () => {
              resolve();
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(n).toBe(1);
    } finally {
      srv.close();
    }
  });
});
