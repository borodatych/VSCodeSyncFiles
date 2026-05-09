/**
 * v2.20.4 — opt-in resolver tests.
 */
import { describe, expect, it, vi } from "vitest";
import { PasskeyTransportNotEnabledError } from "../../src/core/passkeyPeerRegistryTransport.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback?: T): T | undefined => {
        if (key === "vscodesync.passkey.peerRegistrySync") {
          return (globalThis as { __PASSKEY_MODE?: T }).__PASSKEY_MODE ?? fallback;
        }
        return fallback;
      },
    }),
  },
}));

import {
  isPasskeyPeerSyncEnabled,
  readPasskeyPeerSyncMode,
  sendLocalRegistryToPeer,
} from "../../src/ui/passkeyPeerSyncOptIn.js";

function setMode(mode: string | undefined): void {
  (globalThis as { __PASSKEY_MODE?: unknown }).__PASSKEY_MODE = mode;
}

describe("readPasskeyPeerSyncMode", () => {
  it("defaults to off when setting absent", () => {
    setMode(undefined);
    expect(readPasskeyPeerSyncMode()).toBe("off");
  });
  it("normalises unknown strings to off", () => {
    setMode("garbage");
    expect(readPasskeyPeerSyncMode()).toBe("off");
  });
  it("returns p2p when set", () => {
    setMode("p2p");
    expect(readPasskeyPeerSyncMode()).toBe("p2p");
  });
  it("returns cloud_mirror when set", () => {
    setMode("cloud_mirror");
    expect(readPasskeyPeerSyncMode()).toBe("cloud_mirror");
  });
});

describe("isPasskeyPeerSyncEnabled", () => {
  it("false when off", () => {
    setMode("off");
    expect(isPasskeyPeerSyncEnabled()).toBe(false);
  });
  it("true when p2p", () => {
    setMode("p2p");
    expect(isPasskeyPeerSyncEnabled()).toBe(true);
  });
});

describe("sendLocalRegistryToPeer", () => {
  it("calls send when expected transport matches setting", async () => {
    setMode("p2p");
    let called = false;
    await sendLocalRegistryToPeer("p2p", () => {
      called = true;
      return Promise.resolve();
    });
    expect(called).toBe(true);
  });

  it("throws sentinel when expected transport differs from setting", async () => {
    setMode("off");
    await expect(sendLocalRegistryToPeer("p2p", () => Promise.resolve())).rejects.toBeInstanceOf(
      PasskeyTransportNotEnabledError,
    );
  });

  it("throws sentinel when transport mismatch (cloud_mirror vs p2p)", async () => {
    setMode("cloud_mirror");
    await expect(sendLocalRegistryToPeer("p2p", () => Promise.resolve())).rejects.toBeInstanceOf(
      PasskeyTransportNotEnabledError,
    );
  });
});
