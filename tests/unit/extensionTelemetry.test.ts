import { describe, expect, it } from "vitest";
import { isSafeTelemetryIngestUrl } from "../../src/telemetry/telemetryIngestUrl.js";

describe("isSafeTelemetryIngestUrl", () => {
  it("allows https without auth", () => {
    expect(isSafeTelemetryIngestUrl("https://example.com/ingest")).toBe(true);
  });
  it("allows http for localhost-style dev", () => {
    expect(isSafeTelemetryIngestUrl("http://127.0.0.1:3000/collect")).toBe(true);
  });
  it("rejects non-http(s)", () => {
    expect(isSafeTelemetryIngestUrl("file:///tmp/x")).toBe(false);
    expect(isSafeTelemetryIngestUrl("javascript:alert(1)")).toBe(false);
  });
  it("rejects embedded credentials", () => {
    expect(isSafeTelemetryIngestUrl("https://user:pass@example.com/x")).toBe(false);
  });
});
