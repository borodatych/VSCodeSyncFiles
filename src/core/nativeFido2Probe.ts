/**
 * v2.2.2 — native FIDO2 binding probe (skeleton).
 *
 * The webview-based path (`runWebAuthnEnroll`/`runWebAuthnUnlock` in
 * `src/ui/webauthnWebview.ts`) covers desktop and vscode.dev today: Electron
 * forwards `navigator.credentials.create/get` to the OS FIDO2 stack
 * automatically. A native `node-webauthn` (or `libfido2`) binding would let
 * us run the ceremony without spawning a webview — useful for headless
 * scenarios (extension host has no UI, e.g. remote SSH server with FIDO2
 * forwarding via `ssh -o ForwardX11=no -o RemoteCommand="..."`) and for the
 * CLI sub-package.
 *
 * This module is the **probe**: it attempts a lazy-require of the native
 * binding without listing it in `package.json`, so installation never fails
 * on machines without a working FIDO2 toolchain. Three return shapes:
 *
 *   - `available: true`  — binding loaded and exposes the expected methods.
 *   - `available: false, reason: "module_not_installed"` — npm package
 *     wasn't installed on this machine; webview path remains in effect.
 *   - `available: false, reason: "module_load_failed"` — installed but
 *     load threw (postinstall likely failed); detail copied to `error`.
 *
 * The `WebAuthnAdapter` returned on `available: true` still throws the
 * standard sentinel `WebAuthnNotImplementedError` until v2.2.2 wires real
 * `node-webauthn` API — this skeleton lets the caller route to the correct
 * "not yet wired" message instead of catching a module-not-found exception.
 */
import type { WebAuthnAdapter } from "./webauthnPlatformAdapter.js";
import { makeSkeletonWebAuthnAdapter } from "./webauthnPlatformAdapter.js";

export type NativeFido2ProbeResult =
  | { available: true; adapter: WebAuthnAdapter; backendName: string }
  | { available: false; reason: "module_not_installed" | "module_load_failed"; error?: string };

/**
 * Names of npm packages the probe attempts to load, in priority order.
 * Default: empty — the project has not opted-in to a native binding yet.
 * Future: `["node-webauthn", "fido2-lib"]` (both are real npm packages
 * with `Authenticator` style API).
 */
export const NATIVE_FIDO2_CANDIDATES: readonly string[] = [];

export interface ProbeOptions {
  /** Test seam — caller can inject custom candidates. */
  readonly candidates?: readonly string[];
  /** Test seam — caller can inject a `require`-like resolver to avoid
   *  hitting the real loader during unit tests. */
  readonly loader?: (moduleName: string) => unknown;
}

/**
 * Synchronous variant — returns the first candidate that loads. The probe
 * never throws; failure modes are surfaced via the discriminated result.
 */
export function probeNativeFido2(options: ProbeOptions = {}): NativeFido2ProbeResult {
  const candidates = options.candidates ?? NATIVE_FIDO2_CANDIDATES;
  if (candidates.length === 0) {
    return { available: false, reason: "module_not_installed" };
  }
  const loader =
    options.loader ??
    ((name: string): unknown => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(name) as unknown;
    });

  let lastError: string | undefined;
  for (const name of candidates) {
    try {
      const mod = loader(name);
      if (mod !== null && typeof mod === "object") {
        return { available: true, adapter: makeSkeletonWebAuthnAdapter("native"), backendName: name };
      }
      lastError = `${name}: module returned non-object`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Both Node ESM (ERR_MODULE_NOT_FOUND) and CJS (Cannot find module) error
      // shapes route here. Distinguish "missing" from "load failed".
      if (/cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
        lastError = msg;
        continue;
      }
      return { available: false, reason: "module_load_failed", error: msg };
    }
  }
  return { available: false, reason: "module_not_installed", error: lastError };
}
