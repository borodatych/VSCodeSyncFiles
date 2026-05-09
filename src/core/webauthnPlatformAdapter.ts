/**
 * v2.20.4 — typed surface for the WebAuthn / FIDO2 unlock path.
 * **Skeleton.** No `navigator.credentials` import, no `node-webauthn`
 * binding. Interfaces only, plus a sentinel error so callers see a clean
 * failure shape instead of a TypeError.
 *
 * Two adapter shapes the future implementations target:
 *
 *   - `WebAuthnPlatformAdapter` — `navigator.credentials.create/.get` for
 *     vscode.dev / Cursor / browser-based webview surfaces.
 *   - `WebAuthnNativeAdapter` — `node-webauthn` (or libfido2 binding) for
 *     native VS Code / Cursor when the platform supports it.
 */

export interface WebAuthnEnrollRequest {
  rpId: string;
  rpName: string;
  /** User handle (opaque, ≤ 64 bytes per spec). */
  userHandle: Uint8Array;
  userDisplayName: string;
  /** PRF / HMAC-secret extension hint salt. */
  prfSalt?: Uint8Array;
}

export interface WebAuthnEnrollResult {
  credentialId: string;
  publicKey: string;
  /** Raw user-agent recorded for the device label heuristic. */
  userAgent: string;
}

export interface WebAuthnUnlockRequest {
  rpId: string;
  /** Specific credential ids to try; empty array means "any". */
  allowedCredentialIds: string[];
  prfSalt?: Uint8Array;
}

export interface WebAuthnUnlockResult {
  credentialId: string;
  /** PRF/HMAC-secret output that the KDF chains into the KEK. */
  prfSecret: Uint8Array;
}

export interface WebAuthnAdapter {
  readonly platform: "browser" | "native";
  readonly available: boolean;
  enroll: (req: WebAuthnEnrollRequest) => Promise<WebAuthnEnrollResult>;
  unlock: (req: WebAuthnUnlockRequest) => Promise<WebAuthnUnlockResult>;
}

export class WebAuthnNotImplementedError extends Error {
  readonly code = "webauthn_not_implemented" as const;
  constructor(platform: "browser" | "native", message?: string) {
    super(
      message ??
        `WebAuthn ${platform} adapter is in skeleton mode (v2.20.4 in roadmap). ` +
          "navigator.credentials / node-webauthn binding will land in a follow-up.",
    );
    this.name = "WebAuthnNotImplementedError";
  }
}

/** Sentinel adapter that throws on every call but reports `available: false`,
 * so the UI can branch on the flag and show "passkey enrol not yet wired"
 * instead of catching a generic exception. */
export function makeSkeletonWebAuthnAdapter(
  platform: "browser" | "native" = "browser",
): WebAuthnAdapter {
  const reject = (): Promise<never> =>
    Promise.reject(new WebAuthnNotImplementedError(platform));
  return {
    platform,
    available: false,
    enroll: reject,
    unlock: reject,
  };
}
