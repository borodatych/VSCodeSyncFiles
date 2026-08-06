/**
 * v3.C — pure schema migration + slot CRUD for the multi-account variant of
 * `globalConfig`. The shipped v1 schema only stores one tokens object per
 * `ProviderType`; this module describes a forward-compatible
 * `MultiAccountConfig` shape and the deterministic helpers that the
 * `globalConfigManager` will run on read.
 *
 * The migration is one-way (single → multi). Forward-compat: old readers
 * that still consume `providers[type]: ProviderTokens` will see the first
 * slot's metadata; new readers consume the `accounts[]` array directly.
 *
 * No `vscode` import. No SecretStorage access here either — token storage
 * keying remains the caller's responsibility.
 */

import type { GlobalConfig, ProviderTokens, ProviderType } from "./types.js";

export interface AccountSlot {
  id: string;
  displayName: string;
  /** Sensitive token blob is in SecretStorage under the key built by
   * `secretKeyForAccountSlot(providerType, id)` (`providers/_shared/tokenStore.ts`);
   * this field carries only non-sensitive metadata mirrored from
   * `ProviderTokens`. */
  metadata: ProviderTokens;
}

export type MultiAccountProviderMap = Partial<
  Record<ProviderType, AccountSlot[]>
>;

export interface MultiAccountConfig
  extends Omit<GlobalConfig, "providers"> {
  /** New shape — replaces `providers` (kept under a different key so old
   * readers don't hit a type mismatch). */
  accounts: MultiAccountProviderMap;
  /** Per-workspace selected account: `{ workspaceId: { providerType, slotId } }` */
  workspaceAccount?: Record<string, WorkspaceAccountBinding>;
}

export interface WorkspaceAccountBinding {
  providerType: ProviderType;
  slotId: string;
}

/** Deterministic slot id used during migration. Caller may overwrite later. */
export const DEFAULT_PRIMARY_SLOT_ID = "primary";

/**
 * One-way migration from the legacy `providers: { type: ProviderTokens }`
 * shape to `accounts: { type: AccountSlot[] }`. Idempotent — running on an
 * already-migrated config is a no-op (preserves existing accounts +
 * workspaceAccount).
 */
export function migrateToMultiAccountConfig(
  source: GlobalConfig | MultiAccountConfig,
): MultiAccountConfig {
  if (isMultiAccountConfig(source)) {
    return source;
  }
  const accounts: MultiAccountProviderMap = {};
  for (const [type, tokens] of Object.entries(source.providers)) {
    accounts[type as ProviderType] = [
      {
        id: DEFAULT_PRIMARY_SLOT_ID,
        displayName: tokens.accountLabel ?? "Primary",
        metadata: tokens,
      },
    ];
  }
  // Strip `providers` from the source — multi-account schema is the source
  // of truth post-migration.
  const { providers: _ignored, ...rest } = source;
  return {
    ...rest,
    accounts,
  };
}

export function isMultiAccountConfig(
  candidate: GlobalConfig | MultiAccountConfig,
): candidate is MultiAccountConfig {
  if (!("accounts" in candidate)) return false;
  return typeof candidate.accounts === "object";
}

export type AddAccountSlotResult =
  | { ok: true; config: MultiAccountConfig }
  | { ok: false; reason: "duplicate_id" | "empty_id" | "empty_display_name" };

/** Add a new slot for the given provider. Caller has already obtained
 * tokens via OAuth; this just records the metadata. */
export function addAccountSlot(
  config: MultiAccountConfig,
  providerType: ProviderType,
  slot: AccountSlot,
): AddAccountSlotResult {
  if (slot.id.trim().length === 0) return { ok: false, reason: "empty_id" };
  if (slot.displayName.trim().length === 0) {
    return { ok: false, reason: "empty_display_name" };
  }
  const existing = config.accounts[providerType] ?? [];
  if (existing.some((s) => s.id === slot.id)) {
    return { ok: false, reason: "duplicate_id" };
  }
  return {
    ok: true,
    config: {
      ...config,
      accounts: {
        ...config.accounts,
        [providerType]: [...existing, slot],
      },
    },
  };
}

export type RemoveAccountSlotResult =
  | { ok: true; config: MultiAccountConfig; orphanedWorkspaceIds: string[] }
  | { ok: false; reason: "unknown_slot" | "would_orphan_active_provider" };

/** Remove a slot. Returns the list of workspaceIds that had been bound to
 * this slot — caller must reassign those to another slot or surface a
 * choice modal. */
export function removeAccountSlot(
  config: MultiAccountConfig,
  providerType: ProviderType,
  slotId: string,
): RemoveAccountSlotResult {
  const existing = config.accounts[providerType] ?? [];
  if (!existing.some((s) => s.id === slotId)) {
    return { ok: false, reason: "unknown_slot" };
  }
  if (config.activeProvider === providerType && existing.length === 1) {
    return { ok: false, reason: "would_orphan_active_provider" };
  }
  const remaining = existing.filter((s) => s.id !== slotId);
  const orphanedWorkspaceIds: string[] = [];
  const newWorkspaceAccount: Record<string, WorkspaceAccountBinding> = {};
  for (const [wsId, binding] of Object.entries(config.workspaceAccount ?? {})) {
    if (binding.providerType === providerType && binding.slotId === slotId) {
      orphanedWorkspaceIds.push(wsId);
      continue; // drop the binding
    }
    newWorkspaceAccount[wsId] = binding;
  }
  return {
    ok: true,
    config: {
      ...config,
      accounts: {
        ...config.accounts,
        [providerType]: remaining,
      },
      workspaceAccount: newWorkspaceAccount,
    },
    orphanedWorkspaceIds,
  };
}

export type PickAccountSlotResult =
  | { ok: true; slot: AccountSlot }
  | { ok: false; reason: "no_provider" | "unknown_slot" };

/** Look up the slot bound to a specific workspace, or fall back to the
 * first slot for that provider when no binding exists. */
export function pickAccountSlot(
  config: MultiAccountConfig,
  providerType: ProviderType,
  workspaceId: string | undefined,
): PickAccountSlotResult {
  const slots = config.accounts[providerType] ?? [];
  if (slots.length === 0) return { ok: false, reason: "no_provider" };
  if (workspaceId !== undefined) {
    const binding = config.workspaceAccount?.[workspaceId];
    if (binding?.providerType === providerType) {
      const match = slots.find((s) => s.id === binding.slotId);
      if (match) return { ok: true, slot: match };
      return { ok: false, reason: "unknown_slot" };
    }
  }
  return { ok: true, slot: slots[0] };
}
