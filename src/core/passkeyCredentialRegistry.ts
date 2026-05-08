/**
 * v2.2.4 — pure multi-device credential registry for the WebAuthn / FIDO2
 * unlock flow. Stores the enrolled credential set and answers the questions
 * the UI needs to surface settings (`showPasskeySettings`) and the unlock
 * dispatcher (try each id until one succeeds).
 *
 * Storage layer (extension-side) persists the serialised registry into
 * SecretStorage / globalState. This module is pure — no `vscode`, no IO.
 *
 * Shape is forward-compat: `version` field on the wire, unknown fields on
 * `entries[]` are preserved through round-trip via the unionised entry
 * type. Old readers ignore newer optional fields.
 */

import type { PasskeyDeviceEntry } from "./passkeyDevicesFormatter.js";

export interface PasskeyCredentialRegistry {
  version: 1;
  entries: PasskeyDeviceEntry[];
  /** Optional id of the device the user marked "primary". Falls back to
   *  most-recently enrolled when absent. */
  primaryId?: string;
}

export function emptyPasskeyRegistry(): PasskeyCredentialRegistry {
  return { version: 1, entries: [] };
}

export type ParseRegistryResult =
  | { ok: true; registry: PasskeyCredentialRegistry }
  | { ok: false; reason: ParseRegistryRejection };

export type ParseRegistryRejection =
  | "bad_root_shape"
  | "bad_version"
  | "bad_entries"
  | "bad_entry_shape"
  | "bad_primary_id";

/** Strict decoder for serialised registry payloads. Returns `{ ok:false }`
 *  on any malformed shape — never throws. */
export function parsePasskeyRegistry(input: unknown): ParseRegistryResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "bad_root_shape" };
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) return { ok: false, reason: "bad_version" };
  if (!Array.isArray(obj.entries)) return { ok: false, reason: "bad_entries" };
  const entries: PasskeyDeviceEntry[] = [];
  for (const raw of obj.entries) {
    const e = parseEntry(raw);
    if (!e.ok) return { ok: false, reason: e.reason };
    entries.push(e.entry);
  }
  let primaryId: string | undefined;
  if (obj.primaryId !== undefined) {
    if (typeof obj.primaryId !== "string" || obj.primaryId.length === 0) {
      return { ok: false, reason: "bad_primary_id" };
    }
    primaryId = obj.primaryId;
  }
  const registry: PasskeyCredentialRegistry = primaryId === undefined
    ? { version: 1, entries }
    : { version: 1, entries, primaryId };
  return { ok: true, registry };
}

function parseEntry(
  input: unknown,
): { ok: true; entry: PasskeyDeviceEntry } | { ok: false; reason: "bad_entry_shape" } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "bad_entry_shape" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.length === 0) return { ok: false, reason: "bad_entry_shape" };
  if (typeof o.displayName !== "string") return { ok: false, reason: "bad_entry_shape" };
  if (typeof o.userAgent !== "string") return { ok: false, reason: "bad_entry_shape" };
  if (typeof o.enrolledAtMs !== "number" || !Number.isFinite(o.enrolledAtMs)) {
    return { ok: false, reason: "bad_entry_shape" };
  }
  const lastUsedAtMs =
    o.lastUsedAtMs === null
      ? null
      : typeof o.lastUsedAtMs === "number" && Number.isFinite(o.lastUsedAtMs)
        ? o.lastUsedAtMs
        : "bad";
  if (lastUsedAtMs === "bad") return { ok: false, reason: "bad_entry_shape" };
  return {
    ok: true,
    entry: {
      id: o.id,
      displayName: o.displayName,
      userAgent: o.userAgent,
      enrolledAtMs: o.enrolledAtMs,
      lastUsedAtMs,
    },
  };
}

/** Insert or update an entry. Existing id → in-place update (preserves
 *  enrolledAtMs unless caller forces it). New id → append. Idempotent. */
export function upsertCredential(
  registry: PasskeyCredentialRegistry,
  entry: PasskeyDeviceEntry,
): PasskeyCredentialRegistry {
  const existingIndex = registry.entries.findIndex((e) => e.id === entry.id);
  if (existingIndex < 0) {
    return { ...registry, entries: [...registry.entries, entry] };
  }
  const next = registry.entries.slice();
  next[existingIndex] = entry;
  return { ...registry, entries: next };
}

/** Remove the entry with this id. If it was primary, primaryId is cleared. */
export function removeCredential(
  registry: PasskeyCredentialRegistry,
  id: string,
): PasskeyCredentialRegistry {
  const next = registry.entries.filter((e) => e.id !== id);
  if (registry.primaryId === id) {
    const { primaryId, ...rest } = registry;
    void primaryId;
    return { ...rest, entries: next };
  }
  return { ...registry, entries: next };
}

/** Mark a credential as primary. Throws when id not present. */
export function setPrimaryCredential(
  registry: PasskeyCredentialRegistry,
  id: string,
): PasskeyCredentialRegistry {
  const exists = registry.entries.some((e) => e.id === id);
  if (!exists) {
    throw new Error(`passkeyCredentialRegistry: id "${id}" not present`);
  }
  return { ...registry, primaryId: id };
}

/** Returns the primary credential, or — when `primaryId` is unset — the
 *  most-recently enrolled. `null` when registry is empty. */
export function findPrimaryCredential(
  registry: PasskeyCredentialRegistry,
): PasskeyDeviceEntry | null {
  if (registry.entries.length === 0) return null;
  if (registry.primaryId !== undefined) {
    const hit = registry.entries.find((e) => e.id === registry.primaryId);
    if (hit !== undefined) return hit;
  }
  return registry.entries.reduce((best, e) =>
    e.enrolledAtMs > best.enrolledAtMs ? e : best,
  );
}

export function findCredentialById(
  registry: PasskeyCredentialRegistry,
  id: string,
): PasskeyDeviceEntry | null {
  return registry.entries.find((e) => e.id === id) ?? null;
}

/** Order entries the way `renderPasskeyDevicesHtml` expects: primary
 *  first when set, then most-recently enrolled. */
export function orderForDisplay(
  registry: PasskeyCredentialRegistry,
): PasskeyDeviceEntry[] {
  const sorted = registry.entries.slice().sort((a, b) => b.enrolledAtMs - a.enrolledAtMs);
  if (registry.primaryId === undefined) return sorted;
  const idx = sorted.findIndex((e) => e.id === registry.primaryId);
  if (idx <= 0) return sorted;
  const primary = sorted.splice(idx, 1)[0];
  return [primary, ...sorted];
}

/** Update lastUsedAtMs for a successful unlock. No-op when id absent. */
export function noteCredentialUsed(
  registry: PasskeyCredentialRegistry,
  id: string,
  nowMs: number,
): PasskeyCredentialRegistry {
  const idx = registry.entries.findIndex((e) => e.id === id);
  if (idx < 0) return registry;
  const next = registry.entries.slice();
  next[idx] = { ...next[idx], lastUsedAtMs: nowMs };
  return { ...registry, entries: next };
}
