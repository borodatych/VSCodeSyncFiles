/**
 * v2.20.4 — OAuth 2.1 PAR planner tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrlWithRequestUri,
  buildParRequestBody,
  parseParResponse,
  ParEndpointNotConfiguredError,
} from "../../src/core/oauthPushedAuthRequest.js";

describe("buildParRequestBody", () => {
  it("emits canonical x-www-form-urlencoded body", () => {
    const body = buildParRequestBody({
      clientId: "abc",
      redirectUri: "vscode://ext/callback",
      responseType: "code",
      scope: "files.read files.write",
      state: "state123",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    });
    const usp = new URLSearchParams(body);
    expect(usp.get("client_id")).toBe("abc");
    expect(usp.get("redirect_uri")).toBe("vscode://ext/callback");
    expect(usp.get("response_type")).toBe("code");
    expect(usp.get("scope")).toBe("files.read files.write");
    expect(usp.get("code_challenge")).toBe("challenge");
    expect(usp.get("code_challenge_method")).toBe("S256");
  });

  it("merges extra params", () => {
    const body = buildParRequestBody({
      clientId: "abc",
      redirectUri: "x",
      responseType: "code",
      scope: "s",
      state: "st",
      codeChallenge: "c",
      codeChallengeMethod: "S256",
      extra: { audience: "api://my.app" },
    });
    expect(new URLSearchParams(body).get("audience")).toBe("api://my.app");
  });
});

describe("parseParResponse", () => {
  it("accepts a valid response", () => {
    const r = parseParResponse({ request_uri: "urn:par:1", expires_in: 60 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.requestUri).toBe("urn:par:1");
      expect(r.expiresInSec).toBe(60);
    }
  });

  it("flags missing request_uri", () => {
    const r = parseParResponse({ expires_in: 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_request_uri");
  });

  it("flags missing expires_in", () => {
    const r = parseParResponse({ request_uri: "u" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_expires_in");
  });

  it("captures rfc6749 error envelope", () => {
    const r = parseParResponse({ error: "invalid_request", error_description: "bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("rfc6749_error");
      expect(r.oauthError?.error).toBe("invalid_request");
      expect(r.oauthError?.description).toBe("bad");
    }
  });

  it("rejects garbage input", () => {
    expect(parseParResponse(null).ok).toBe(false);
    expect(parseParResponse("not json").ok).toBe(false);
    expect(parseParResponse(42).ok).toBe(false);
  });
});

describe("buildAuthorizeUrlWithRequestUri", () => {
  it("merges client_id + request_uri into the authorise endpoint", () => {
    const url = buildAuthorizeUrlWithRequestUri({
      authorizeEndpoint: "https://auth.example.com/authorize",
      clientId: "cid",
      requestUri: "urn:par:abc",
    });
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("request_uri")).toBe("urn:par:abc");
  });

  it("preserves existing query in the endpoint URL", () => {
    const url = buildAuthorizeUrlWithRequestUri({
      authorizeEndpoint: "https://auth.example.com/authorize?foo=bar",
      clientId: "cid",
      requestUri: "urn:par:1",
    });
    const u = new URL(url);
    expect(u.searchParams.get("foo")).toBe("bar");
    expect(u.searchParams.get("client_id")).toBe("cid");
  });
});

describe("ParEndpointNotConfiguredError", () => {
  it("has the documented code", () => {
    const e = new ParEndpointNotConfiguredError();
    expect(e.code).toBe("par_endpoint_not_configured");
  });
});
