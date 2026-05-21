/**
 * v0.16 N09 — trusted-machines registry.
 *
 * When `vscodesync.requireMachineApproval = true`, every new machine
 * landing on a workspace gets `status: pending` in the manifest until an
 * already-approved machine flips it. For teams collaborating on many
 * workspaces this becomes Modal Hell. The trusted-machines registry is
 * a per-user opt-in list of machineIds that bypass approval.
 *
 * Stored alongside other globalState entries; this module is the pure
 * planner — caller persists.
 */

export interface TrustedMachineEntry {
  machineId: string;
  /** Human label entered by the user when they trust this machine. */
  label: string;
  /** ISO when added. */
  addedAtIso: string;
  /** Optional last-seen ISO for the housekeeping job. */
  lastSeenIso?: string;
}

export interface TrustedMachinesRegistry {
  entries: TrustedMachineEntry[];
}

export const EMPTY_TRUSTED_REGISTRY: TrustedMachinesRegistry = { entries: [] };

export function parseTrustedRegistry(raw: unknown): TrustedMachinesRegistry {
  if (raw === null || typeof raw !== "object") return EMPTY_TRUSTED_REGISTRY;
  const obj = raw as { entries?: unknown };
  if (!Array.isArray(obj.entries)) return EMPTY_TRUSTED_REGISTRY;
  const entries: TrustedMachineEntry[] = [];
  for (const item of obj.entries) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Partial<TrustedMachineEntry>;
    if (typeof e.machineId === "string" && e.machineId.length > 0 &&
        typeof e.label === "string" &&
        typeof e.addedAtIso === "string") {
      entries.push({
        machineId: e.machineId,
        label: e.label,
        addedAtIso: e.addedAtIso,
        lastSeenIso: typeof e.lastSeenIso === "string" ? e.lastSeenIso : undefined,
      });
    }
  }
  return { entries };
}

export function isTrusted(reg: TrustedMachinesRegistry, machineId: string): boolean {
  return reg.entries.some((e) => e.machineId === machineId);
}

export function addTrusted(
  reg: TrustedMachinesRegistry,
  machineId: string,
  label: string,
  nowIso: string = new Date().toISOString(),
): TrustedMachinesRegistry {
  if (isTrusted(reg, machineId)) {
    // Update label if changed.
    return {
      entries: reg.entries.map((e) =>
        e.machineId === machineId ? { ...e, label, lastSeenIso: nowIso } : e,
      ),
    };
  }
  return {
    entries: [...reg.entries, { machineId, label, addedAtIso: nowIso, lastSeenIso: nowIso }],
  };
}

export function removeTrusted(
  reg: TrustedMachinesRegistry,
  machineId: string,
): TrustedMachinesRegistry {
  return { entries: reg.entries.filter((e) => e.machineId !== machineId) };
}

export function noteTrustedSeen(
  reg: TrustedMachinesRegistry,
  machineId: string,
  nowIso: string,
): TrustedMachinesRegistry {
  return {
    entries: reg.entries.map((e) =>
      e.machineId === machineId ? { ...e, lastSeenIso: nowIso } : e,
    ),
  };
}
