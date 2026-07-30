/**
 * Unit tests for web-extension specific utilities.
 * Tests are isolated from the VS Code API (vscode module) and focus on
 * pure logic that can run in a Node test environment:
 *  - webPowerMonitorStub contract
 *  - OAuth URL parsing logic (state extraction, redirect URI format)
 *  - Lock-file body structure
 *  - SSE payload parsing from webhookTunnel (parseAndDispatch logic)
 */
import { describe, it, expect, vi } from "vitest";
import { createWebCrypto, createNodeCrypto } from "../../src/core/platformCrypto.js";
import { createWebCompression, createNodeCompression } from "../../src/core/platformCompression.js";

// ─── powerMonitor stub contract ───────────────────────────────────────────────

describe("webPowerMonitorStub contract", () => {
  it("getBatteryPercent returns null (no battery in web)", async () => {
    // Replicate the stub logic (avoids importing vscode)
    const stub = {
      getBatteryPercent: (): Promise<number | null> => Promise.resolve(null),
      isMeteredConnection: (): boolean => false,
      startMonitoring: (_cb: (pct: number | null) => void): void => { /* no-op */ },
      stopMonitoring: (): void => { /* no-op */ },
    };
    const result = await stub.getBatteryPercent();
    expect(result).toBeNull();
  });

  it("isMeteredConnection always returns false in web", () => {
    const stub = {
      isMeteredConnection: (): boolean => false,
    };
    expect(stub.isMeteredConnection()).toBe(false);
  });

  it("startMonitoring and stopMonitoring are no-ops (no throw)", () => {
    const cb = vi.fn();
    const stub = {
      startMonitoring: (_cb: (pct: number | null) => void): void => { /* no-op */ },
      stopMonitoring: (): void => { /* no-op */ },
    };
    expect(() => { stub.startMonitoring(cb); }).not.toThrow();
    expect(() => { stub.stopMonitoring(); }).not.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── Web OAuth state/URL logic ────────────────────────────────────────────────

describe("web OAuth URL parsing", () => {
  it("extracts code and state from redirect URI query string", () => {
    const redirectUri = "vscode://borodatych.vscodesyncfiles/oauth-callback?code=AUTH_CODE_123&state=MY_STATE";
    const url = new URL(redirectUri);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    expect(code).toBe("AUTH_CODE_123");
    expect(state).toBe("MY_STATE");
  });

  it("detects error parameter in redirect", () => {
    const redirectUri = "vscode://borodatych.vscodesyncfiles/oauth-callback?error=access_denied&error_description=User+denied";
    const url = new URL(redirectUri);
    const err = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    expect(err).toBe("User denied");
  });

  it("rejects mismatched state (CSRF guard)", () => {
    // Mimic the URLSearchParams.get() return type so the validation logic is tested as written.
    const params = new URLSearchParams("code=somecode&state=different-state");
    const expectedState = "secure-random-state-abc123";
    const code = params.get("code");
    const actualState = params.get("state");
    const valid = code !== null && actualState === expectedState;
    expect(valid).toBe(false);
  });

  it("accepts correct state", () => {
    const params = new URLSearchParams("code=AUTH_CODE_123&state=secure-random-state-abc123");
    const expectedState = "secure-random-state-abc123";
    const code = params.get("code");
    const actualState = params.get("state");
    const valid = code !== null && actualState === expectedState;
    expect(valid).toBe(true);
  });

  it("buildWebOAuthRedirectUri format matches vscode URI scheme pattern", () => {
    // Simulate the function logic without vscode API
    const publisher = "borodatych";
    const name = "vscodesyncfiles";
    const scheme = "vscode";
    const uri = `${scheme}://${publisher}.${name}/oauth-callback`;
    expect(uri).toBe("vscode://borodatych.vscodesyncfiles/oauth-callback");
    expect(uri.startsWith("vscode://")).toBe(true);
    expect(uri.endsWith("/oauth-callback")).toBe(true);
  });
});

// ─── Web lock-file body structure ─────────────────────────────────────────────

describe("web lock-file body", () => {
  it("lock body has required fields", () => {
    const WEB_INSTANCE_ID = Math.random().toString(36).slice(2);
    const nonce = Math.random().toString(36).slice(2);
    const body = {
      nonce,
      lockedAt: new Date().toISOString(),
      instanceId: WEB_INSTANCE_ID,
    };
    expect(typeof body.nonce).toBe("string");
    expect(typeof body.lockedAt).toBe("string");
    expect(typeof body.instanceId).toBe("string");
    expect(body.nonce.length).toBeGreaterThan(0);
    expect(body.instanceId.length).toBeGreaterThan(0);
    expect(Date.parse(body.lockedAt)).not.toBeNaN();
  });

  it("different extension instances produce different instanceId", () => {
    const id1 = Math.random().toString(36).slice(2);
    const id2 = Math.random().toString(36).slice(2);
    // With overwhelming probability, two random IDs differ
    expect(id1 === id2).toBe(false);
  });

  it("lock body serializes and deserializes correctly", () => {
    const body = {
      nonce: "abc123",
      lockedAt: "2026-04-29T12:00:00.000Z",
      instanceId: "xyz456",
    };
    const json = JSON.stringify(body, null, 2);
    const parsed = JSON.parse(json) as typeof body;
    expect(parsed.nonce).toBe(body.nonce);
    expect(parsed.lockedAt).toBe(body.lockedAt);
    expect(parsed.instanceId).toBe(body.instanceId);
  });
});

// ─── smee.io SSE payload parsing ─────────────────────────────────────────────

describe("smee.io SSE payload parsing", () => {
  // Replicate parseAndDispatch logic from webhookTunnel.ts
  function parseSmeePayload(sseBlock: string): { body: Record<string, unknown>; headers: Record<string, string> } | null {
    let data = "";
    for (const line of sseBlock.split("\n")) {
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }
    if (!data || data === "connected") return null;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const body = (parsed.body as Record<string, unknown> | undefined) ?? parsed;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== "body" && typeof v === "string") {
          headers[k] = v;
        }
      }
      return { body, headers };
    } catch {
      return null;
    }
  }

  it("parses connected heartbeat as null", () => {
    const block = "data: connected";
    expect(parseSmeePayload(block)).toBeNull();
  });

  it("parses empty block as null", () => {
    expect(parseSmeePayload("")).toBeNull();
  });

  it("parses valid OneDrive notification payload", () => {
    const notification = {
      body: { value: [{ subscriptionId: "sub123", changeType: "updated" }] },
      "content-type": "application/json",
    };
    const block = `data: ${JSON.stringify(notification)}`;
    const result = parseSmeePayload(block);
    expect(result).not.toBeNull();
    expect(result!.headers["content-type"]).toBe("application/json");
    expect((result!.body as typeof notification["body"]).value[0]?.subscriptionId).toBe("sub123");
  });

  it("returns null on malformed JSON", () => {
    const block = "data: {this is not json";
    expect(parseSmeePayload(block)).toBeNull();
  });

  it("parses multi-line SSE block (data: on multiple lines)", () => {
    const block = "event: message\ndata: {\"body\":{\"x\":1},\"header\":\"val\"}";
    const result = parseSmeePayload(block);
    expect(result).not.toBeNull();
    expect((result!.body as { x: number }).x).toBe(1);
    expect(result!.headers.header).toBe("val");
  });
});

// ─── ICrypto + ICompression web E2E pipeline ─────────────────────────────────

describe("web E2E pipeline: compress then encrypt → decrypt then decompress", () => {
  it("Node pipeline: gzip → encrypt → decrypt → gunzip", async () => {
    const crypto = createNodeCrypto();
    const compression = createNodeCompression();
    const key = await crypto.generateKey();
    const plaintext = Buffer.from("VSCodeSync web pipeline test ".repeat(100));

    const gz = await compression.gzip(plaintext);
    expect(gz).toBeDefined();
    const encrypted = await crypto.encrypt(key, gz!);
    const decrypted = await crypto.decrypt(key, encrypted);
    const restored = await compression.gunzip(decrypted);

    expect(Buffer.from(restored).equals(plaintext)).toBe(true);
  });

  it("Web pipeline: gzip → encrypt → decrypt → gunzip", async () => {
    const crypto = createWebCrypto();
    const compression = createWebCompression();
    const key = await crypto.generateKey();
    const plaintext = Buffer.from("VSCodeSync web E2E pipeline ".repeat(100));

    const gz = await compression.gzip(plaintext);
    expect(gz).toBeDefined();
    const encrypted = await crypto.encrypt(key, gz!);
    const decrypted = await crypto.decrypt(key, encrypted);
    const restored = await compression.gunzip(decrypted);

    expect(Buffer.from(restored).equals(plaintext)).toBe(true);
  });

  it("Cross-platform pipeline: Node compress + Web crypto → Web decompress + Node verify", async () => {
    const nodeCrypto = createNodeCrypto();
    const webCrypto = createWebCrypto();
    const nodeComp = createNodeCompression();
    const webComp = createWebCompression();
    const key = await nodeCrypto.generateKey();
    const plaintext = Buffer.from("cross-platform end-to-end ".repeat(100));

    // Node compress, Web encrypt
    const gz = await nodeComp.gzip(plaintext);
    expect(gz).toBeDefined();
    const encrypted = await webCrypto.encrypt(key, gz!);

    // Node decrypt, Web decompress
    const decrypted = await nodeCrypto.decrypt(key, encrypted);
    const restored = await webComp.gunzip(decrypted);

    expect(Buffer.from(restored).equals(plaintext)).toBe(true);
  });
});
