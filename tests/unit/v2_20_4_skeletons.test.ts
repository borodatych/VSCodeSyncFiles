/**
 * v2.20.4 — skeleton registry tests (SSE / PAR / passkey transport).
 */
import { describe, expect, it } from "vitest";
import {
  SSE_PROVIDER_REGISTRY,
  SseProviderUnavailableError,
  getSseProviderConfig,
  listAvailableSseProviders,
} from "../../src/core/sseProviderRegistry.js";
import {
  PAR_PROVIDER_REGISTRY,
  extendParParamsForProvider,
  getParProviderConfig,
  isParAvailableFor,
} from "../../src/core/parProviderRegistry.js";
import {
  PasskeyTransportNotEnabledError,
  decodePeerRegistryFrame,
  encodePeerRegistryFrame,
} from "../../src/core/passkeyPeerRegistryTransport.js";

describe("SSE provider registry", () => {
  it("declares all four providers as currently unavailable", () => {
    expect(SSE_PROVIDER_REGISTRY).toHaveLength(4);
    for (const p of SSE_PROVIDER_REGISTRY) expect(p.available).toBe(false);
  });
  it("listAvailableSseProviders returns empty until a provider ships SSE", () => {
    expect(listAvailableSseProviders()).toEqual([]);
  });
  it("getSseProviderConfig finds by id", () => {
    expect(getSseProviderConfig("gdrive")?.id).toBe("gdrive");
  });
  it("SseProviderUnavailableError carries id + reason", () => {
    const e = new SseProviderUnavailableError("gdrive", "scope missing");
    expect(e.providerId).toBe("gdrive");
    expect(e.message).toContain("scope missing");
  });
});

describe("PAR provider registry", () => {
  it("declares all four providers as currently unavailable", () => {
    expect(PAR_PROVIDER_REGISTRY).toHaveLength(4);
    for (const p of PAR_PROVIDER_REGISTRY) expect(p.parEndpointUrl).toBeNull();
  });
  it("isParAvailableFor returns false for every provider", () => {
    for (const id of ["onedrive", "gdrive", "dropbox", "yandex"] as const) {
      expect(isParAvailableFor(id)).toBe(false);
    }
  });
  it("extendParParamsForProvider is a no-op when provider has no extraParams", () => {
    const base = {
      clientId: "c",
      redirectUri: "r",
      responseType: "code" as const,
      scope: "s",
      state: "st",
      codeChallenge: "ch",
      codeChallengeMethod: "S256" as const,
    };
    const out = extendParParamsForProvider(base, "onedrive");
    expect(out).toEqual(base);
  });
  it("getParProviderConfig finds by id", () => {
    expect(getParProviderConfig("onedrive")?.id).toBe("onedrive");
  });
});

describe("passkey peer-registry transport", () => {
  it("round-trips an empty registry", () => {
    const buf = encodePeerRegistryFrame({ version: 1, entries: [] });
    const r = decodePeerRegistryFrame(buf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame.registry.entries).toEqual([]);
  });

  it("rejects bad JSON envelope", () => {
    const r = decodePeerRegistryFrame(new TextEncoder().encode("not json"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_envelope");
  });

  it("rejects unknown version", () => {
    const buf = new TextEncoder().encode(JSON.stringify({ v: 999, registry: { version: 1, entries: [] } }));
    const r = decodePeerRegistryFrame(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_version");
  });

  it("rejects bad payload shape", () => {
    const buf = new TextEncoder().encode(JSON.stringify({ v: 1, registry: { totally: "wrong" } }));
    const r = decodePeerRegistryFrame(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad_payload");
  });

  it("PasskeyTransportNotEnabledError carries transport id", () => {
    const e = new PasskeyTransportNotEnabledError("p2p");
    expect(e.transport).toBe("p2p");
    expect(e.code).toBe("passkey_transport_not_enabled");
  });
});
