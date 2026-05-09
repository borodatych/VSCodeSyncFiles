/**
 * v2.20.4 — multi-device passkey reconciler skeleton.
 *
 * Once the user enrols a passkey on machine A and another on machine B, both
 * registries live independently. iCloud Keychain / Google Password Manager
 * are starting to sync passkeys cross-device — but we still need our own
 * registry to merge incoming entries from a peer's `_machines.json` payload
 * (or a future `vscodesync.passkeys.import` flow) without losing local
 * metadata (lastUsedAtMs, primaryId).
 *
 * This module is a *pure reconciler*:
 *   - Input: local registry + a peer's registry (already parsed via
 *     `parsePasskeyRegistry`).
 *   - Output: a merged registry whose entries are the union by credential id.
 *     `lastUsedAtMs` keeps the most recent value; `displayName` prefers the
 *     local one (user has labeled it on this machine); `primaryId` keeps
 *     the local choice unless the local registry was empty.
 *
 * No `vscode` import. The flow that *fetches* a peer's registry (over P2P
 * or via cloud-mirror) is wired separately.
 */
import type { PasskeyCredentialRegistry } from "./passkeyCredentialRegistry.js";
import type { PasskeyDeviceEntry } from "./passkeyDevicesFormatter.js";

export interface ReconcileReport {
  readonly merged: PasskeyCredentialRegistry;
  /** Credential ids that existed only on the peer side and were imported. */
  readonly addedIds: readonly string[];
  /** Credential ids that already existed locally; their `lastUsedAtMs` may
   *  have advanced. */
  readonly updatedIds: readonly string[];
}

export function reconcilePasskeyRegistries(
  local: PasskeyCredentialRegistry,
  remote: PasskeyCredentialRegistry,
): ReconcileReport {
  const localById = new Map<string, PasskeyDeviceEntry>();
  for (const e of local.entries) localById.set(e.id, e);

  const merged: PasskeyDeviceEntry[] = [];
  const addedIds: string[] = [];
  const updatedIds: string[] = [];

  // Walk local first to preserve order.
  for (const e of local.entries) merged.push(e);

  for (const r of remote.entries) {
    const existing = localById.get(r.id);
    if (!existing) {
      merged.push(r);
      addedIds.push(r.id);
      continue;
    }
    const lastUsed = mostRecent(existing.lastUsedAtMs, r.lastUsedAtMs);
    if (lastUsed !== existing.lastUsedAtMs) {
      const idx = merged.indexOf(existing);
      if (idx >= 0) merged[idx] = { ...existing, lastUsedAtMs: lastUsed };
      updatedIds.push(r.id);
    }
  }

  // Keep local primaryId; fall back to remote when local had none.
  let primaryId = local.primaryId;
  if (primaryId === undefined && remote.primaryId !== undefined) {
    primaryId = remote.primaryId;
  }
  // If primary id no longer exists in the merged set, drop it.
  if (primaryId !== undefined && !merged.some((e) => e.id === primaryId)) {
    primaryId = undefined;
  }

  return {
    merged: { version: 1, entries: merged, ...(primaryId === undefined ? {} : { primaryId }) },
    addedIds,
    updatedIds,
  };
}

function mostRecent(a: number | null | undefined, b: number | null | undefined): number | null {
  const av = typeof a === "number" ? a : null;
  const bv = typeof b === "number" ? b : null;
  if (av === null) return bv;
  if (bv === null) return av;
  return Math.max(av, bv);
}

export class PasskeyImportNotImplementedError extends Error {
  readonly code = "passkey_import_not_wired" as const;
  constructor(message?: string) {
    super(
      message ??
        "Passkey import flow (v2.20.4 in roadmap) is not wired yet. Reconciler " +
          "is ready; the transport that brings a peer's registry in will follow.",
    );
    this.name = "PasskeyImportNotImplementedError";
  }
}
