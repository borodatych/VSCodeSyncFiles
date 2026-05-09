/**
 * v2.20.4 — passkey peer-registry import transport (skeleton).
 *
 * Pairs with the pure reconciler in
 * `src/core/passkeyMultiDeviceReconciler.ts`. Once `reconcilePasskeyRegistries`
 * has merged-by-credential-id semantics, this module is the *transport*: how
 * a peer's registry payload gets to the local machine in the first place.
 *
 * Two transport options on the table:
 *
 *   - **P2P:** during a successful `openP2PSession`, both sides may send
 *     a `passkey_registry_export` frame over the authenticated channel; the
 *     receiver hands it to `reconcilePasskeyRegistries`.
 *   - **Cloud mirror:** publish an encrypted-at-rest blob to
 *     `_machines/{machineId}/passkeys.json` in the active provider's
 *     storage; pulled on each heartbeat tick.
 *
 * Both paths require a privacy gate: opt-in setting + user confirmation.
 * For now the module ships:
 *   - `encodePeerRegistryFrame(registry)` — JSON encoder (forward-compat
 *     wire shape with version + payload).
 *   - `decodePeerRegistryFrame(buffer)` — strict decoder; rejects
 *     malformed shapes with discriminated reasons (`bad_envelope`,
 *     `bad_version`, `bad_payload`).
 *   - Sentinel `PasskeyTransportNotEnabledError` so the wiring layer
 *     fails closed when the feature flag is off.
 */
import {
  parsePasskeyRegistry,
  type PasskeyCredentialRegistry,
} from "./passkeyCredentialRegistry.js";

const FRAME_VERSION = 1;

export interface PeerRegistryFrame {
  readonly v: typeof FRAME_VERSION;
  readonly registry: PasskeyCredentialRegistry;
}

export function encodePeerRegistryFrame(registry: PasskeyCredentialRegistry): Uint8Array {
  const frame: PeerRegistryFrame = { v: FRAME_VERSION, registry };
  return new TextEncoder().encode(JSON.stringify(frame));
}

export type DecodePeerRegistryResult =
  | { ok: true; frame: PeerRegistryFrame }
  | { ok: false; reason: "bad_envelope" | "bad_version" | "bad_payload"; detail?: string };

export function decodePeerRegistryFrame(buffer: Uint8Array): DecodePeerRegistryResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer));
  } catch (e) {
    return { ok: false, reason: "bad_envelope", detail: e instanceof Error ? e.message : String(e) };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "bad_envelope" };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== FRAME_VERSION) {
    return { ok: false, reason: "bad_version", detail: `expected v=${String(FRAME_VERSION)}` };
  }
  const r = parsePasskeyRegistry(obj.registry);
  if (!r.ok) {
    return { ok: false, reason: "bad_payload", detail: r.reason };
  }
  return { ok: true, frame: { v: FRAME_VERSION, registry: r.registry } };
}

export class PasskeyTransportNotEnabledError extends Error {
  readonly code = "passkey_transport_not_enabled" as const;
  constructor(public readonly transport: "p2p" | "cloud_mirror", message?: string) {
    super(
      message ??
        `Passkey peer-registry transport (${transport}) is not enabled (v2.20.4 in roadmap). ` +
          "Enable opt-in setting + provide UI consent flow before wiring.",
    );
    this.name = "PasskeyTransportNotEnabledError";
  }
}
