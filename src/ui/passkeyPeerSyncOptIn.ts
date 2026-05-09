/**
 * v2.20.4 — opt-in resolver for the passkey peer-registry sync setting.
 *
 * `vscodesync.passkey.peerRegistrySync` accepts `"off" | "p2p" | "cloud_mirror"`.
 * This module:
 *   - Reads the setting defensively (unknown value → off).
 *   - Exposes `isPasskeyPeerSyncEnabled()` for UI guards.
 *   - When the user flips the setting on, returns the transport id so the
 *     wiring layer (registers/openP2PSession/cross-cloud mirror) can register
 *     the corresponding sender / receiver.
 *
 * The wire format itself + reconciler are already in `core/`. This module
 * is the *gate*: nothing fans out without an explicit user opt-in, and the
 * skeleton sender throws `PasskeyTransportNotEnabledError` when called from
 * a transport whose flag is off.
 */
import * as vscode from "vscode";
import { PasskeyTransportNotEnabledError } from "../core/passkeyPeerRegistryTransport.js";

export type PasskeyPeerSyncMode = "off" | "p2p" | "cloud_mirror";

const SETTING = "vscodesync.passkey.peerRegistrySync";

export function readPasskeyPeerSyncMode(): PasskeyPeerSyncMode {
  const raw = vscode.workspace.getConfiguration().get<string>(SETTING, "off");
  if (raw === "p2p" || raw === "cloud_mirror") return raw;
  return "off";
}

export function isPasskeyPeerSyncEnabled(): boolean {
  return readPasskeyPeerSyncMode() !== "off";
}

/**
 * Sends the local registry over the chosen transport. Caller passes a
 * `send` function for the active transport; this wrapper enforces the
 * setting check + throws the documented sentinel when the transport is
 * disabled.
 */
export async function sendLocalRegistryToPeer(
  expectedMode: Exclude<PasskeyPeerSyncMode, "off">,
  send: () => Promise<void>,
): Promise<void> {
  const mode = readPasskeyPeerSyncMode();
  if (mode !== expectedMode) {
    throw new PasskeyTransportNotEnabledError(expectedMode);
  }
  await send();
}
