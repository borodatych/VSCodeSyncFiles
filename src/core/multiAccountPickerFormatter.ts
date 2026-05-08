/**
 * v3.C — pure QuickPick row formatter for the slot picker that surfaces
 * inside `connectCloudWorkspace` (and `vscodesync.addProviderAccount`)
 * once `MultiAccountConfig` is in effect.
 *
 * The companion to `multiAccountConfig.ts` slot CRUD: this module renders
 * the slots into the rows the UI drops into a `vscode.QuickPick`. No
 * `vscode` import.
 */

import type { ProviderType } from "./types.js";
import type {
  AccountSlot,
  MultiAccountConfig,
} from "./multiAccountConfig.js";

export interface AccountSlotPickerRow {
  /** Stable slot id — caller maps the picked row back via this. */
  slotId: string;
  label: string;
  description: string;
  detail: string;
  /** Indicates which row the picker should pre-select. */
  picked: boolean;
}

export interface FormatAccountSlotPickerOptions {
  /** Workspace id used to highlight the currently bound slot. When
   * undefined, the first slot is pre-selected. */
  currentWorkspaceId?: string;
  /** Number formatter for last-used-iso → relative ms. Defaults to a
   * "Used N days ago" / "Never used" formatter. */
  formatLastUsed?: (lastUsedIso: string | undefined, nowMs: number) => string;
  /** ms — caller "now" for the relative-time formatter. */
  nowMs?: number;
}

/** Render the slot list into QuickPick-shaped rows. The caller maps each
 * row's `slotId` back to the picked slot in `multiAccountConfig`. */
export function formatAccountSlotPicker(
  config: MultiAccountConfig,
  providerType: ProviderType,
  options: FormatAccountSlotPickerOptions = {},
): AccountSlotPickerRow[] {
  const slots = config.accounts[providerType] ?? [];
  if (slots.length === 0) return [];

  const formatLastUsed = options.formatLastUsed ?? defaultFormatLastUsed;
  const nowMs = options.nowMs ?? Date.now();

  const boundSlotId = options.currentWorkspaceId !== undefined
    ? resolveBoundSlotId(config, providerType, options.currentWorkspaceId)
    : null;

  const rows = slots.map<AccountSlotPickerRow>((slot, index) => {
    const isBound =
      boundSlotId !== null
        ? slot.id === boundSlotId
        : index === 0;
    const description = renderDescription(slot, isBound);
    return {
      slotId: slot.id,
      label: slot.displayName,
      description,
      detail: renderDetail(slot, formatLastUsed, nowMs),
      picked: isBound,
    };
  });

  // Bound slot is rendered first so it lands at the top of QuickPick.
  rows.sort((a, b) => Number(b.picked) - Number(a.picked));
  return rows;
}

function resolveBoundSlotId(
  config: MultiAccountConfig,
  providerType: ProviderType,
  workspaceId: string,
): string | null {
  const binding = config.workspaceAccount?.[workspaceId];
  if (binding?.providerType !== providerType) return null;
  return binding.slotId;
}

function renderDescription(slot: AccountSlot, isBound: boolean): string {
  const parts: string[] = [`id: ${slot.id}`];
  if (isBound) parts.push("(current)");
  return parts.join(" · ");
}

function renderDetail(
  slot: AccountSlot,
  formatLastUsed: (lastUsedIso: string | undefined, nowMs: number) => string,
  nowMs: number,
): string {
  return formatLastUsed(slot.metadata.lastUsedIso, nowMs);
}

function defaultFormatLastUsed(lastUsedIso: string | undefined, nowMs: number): string {
  if (lastUsedIso === undefined) return "Never used";
  const t = Date.parse(lastUsedIso);
  if (Number.isNaN(t)) return "Last used: unknown";
  const ageMs = Math.max(0, nowMs - t);
  return `Last used ${formatRelativeAge(ageMs)} ago`;
}

function formatRelativeAge(ageMs: number): string {
  const days = Math.floor(ageMs / (24 * 60 * 60_000));
  if (days >= 1) return `${String(days)} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ageMs / (60 * 60_000));
  if (hours >= 1) return `${String(hours)} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes >= 1) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  return "less than a minute";
}
