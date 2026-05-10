import { describe, expect, it } from "vitest";
import {
  buildDuckDbBootstrapHtml,
  selectDuckDbVariant,
  DuckDbBootstrapNoBundlesError,
  type DuckDbBundleVariant,
} from "../../src/core/duckdbWebviewBootstrap.js";

const MVP: DuckDbBundleVariant = {
  variant: "mvp",
  workerWebviewUri: "https://wv.host/duckdb-mvp.worker.js",
  wasmWebviewUri: "https://wv.host/duckdb-mvp.wasm",
};
const EH: DuckDbBundleVariant = {
  variant: "eh",
  workerWebviewUri: "https://wv.host/duckdb-eh.worker.js",
  wasmWebviewUri: "https://wv.host/duckdb-eh.wasm",
};
const COI: DuckDbBundleVariant = {
  variant: "coi",
  workerWebviewUri: "https://wv.host/duckdb-coi.worker.js",
  wasmWebviewUri: "https://wv.host/duckdb-coi.wasm",
};

describe("selectDuckDbVariant", () => {
  it("falls back to mvp when no capabilities are advertised", () => {
    const v = selectDuckDbVariant([MVP, EH, COI]);
    expect(v.variant).toBe("mvp");
  });

  it("prefers eh when exceptionHandling is on but coi is off", () => {
    const v = selectDuckDbVariant([MVP, EH, COI], { exceptionHandling: true });
    expect(v.variant).toBe("eh");
  });

  it("prefers coi when crossOriginIsolated even if eh available", () => {
    const v = selectDuckDbVariant([MVP, EH, COI], {
      crossOriginIsolated: true,
      exceptionHandling: true,
    });
    expect(v.variant).toBe("coi");
  });

  it("falls back to mvp when only mvp is available", () => {
    const v = selectDuckDbVariant([MVP], { crossOriginIsolated: true });
    expect(v.variant).toBe("mvp");
  });

  it("throws DuckDbBootstrapNoBundlesError on empty array", () => {
    expect(() => selectDuckDbVariant([])).toThrow(DuckDbBootstrapNoBundlesError);
  });
});

describe("buildDuckDbBootstrapHtml", () => {
  it("emits CSP, nonce, and the selected variant URIs", () => {
    const r = buildDuckDbBootstrapHtml({
      bundles: [MVP, EH],
      cspSource: "vscode-webview://abc",
      nonce: "n0nc3",
      bridgeWebviewUri: "https://wv.host/duckdb-bridge.js",
      capabilities: { exceptionHandling: true },
    });
    expect(r.selectedVariant).toBe("eh");
    expect(r.html).toContain(`Content-Security-Policy`);
    expect(r.html).toContain(`script-src 'nonce-n0nc3' vscode-webview://abc`);
    expect(r.html).toContain(`worker-src vscode-webview://abc blob:`);
    expect(r.html).toContain(`"https://wv.host/duckdb-eh.worker.js"`);
    expect(r.html).toContain(`"https://wv.host/duckdb-eh.wasm"`);
    expect(r.html).toContain(`"https://wv.host/duckdb-bridge.js"`);
    expect(r.html).toContain(`variant: "eh"`);
  });

  it("rejects with sentinel when no bundles supplied", () => {
    expect(() =>
      buildDuckDbBootstrapHtml({
        bundles: [],
        cspSource: "vscode-webview://abc",
        nonce: "n",
        bridgeWebviewUri: "https://wv.host/b.js",
      }),
    ).toThrow(DuckDbBootstrapNoBundlesError);
  });

  it("falls back to mvp when capabilities are absent", () => {
    const r = buildDuckDbBootstrapHtml({
      bundles: [MVP, EH, COI],
      cspSource: "vscode-webview://abc",
      nonce: "n",
      bridgeWebviewUri: "https://wv.host/b.js",
    });
    expect(r.selectedVariant).toBe("mvp");
  });
});
