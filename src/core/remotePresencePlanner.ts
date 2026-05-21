/**
 * F2 — Remote presence (cursor-style chip) — pure planner.
 *
 * Skeleton: given a snapshot of manifest soft-locks and the local machine
 * id, decide which presence chips to render. The actual editor decoration
 * layer (live polling, debouncing) is left for the wiring phase.
 *
 * Sentinel error class — UI catches it specifically and routes to
 * «коллабор-presence ещё в работе» fallback (regular `editingBy` tooltip).
 */

export interface PresenceInput {
  /** All known soft-locks across active workspaces. */
  locks: {
    workspaceId: string;
    workspaceNote?: string;
    posixRel: string;
    editingBy: string;
    editingByName?: string;
    editingSince?: string;
  }[];
  /** Local machine id — excluded from the result. */
  localMachineId: string;
  /** Optional limit; default 3 chips per file. */
  maxChipsPerFile?: number;
}

export interface PresenceChip {
  workspaceId: string;
  posixRel: string;
  machineId: string;
  machineName: string;
  /** Seconds since `editingSince`; undefined if missing/malformed. */
  ageSec?: number;
}

export function planRemotePresenceChips(
  input: PresenceInput,
  nowMs: number = Date.now(),
): PresenceChip[] {
  const out: PresenceChip[] = [];
  const cap = input.maxChipsPerFile ?? 3;
  const byFile = new Map<string, PresenceChip[]>();
  for (const l of input.locks) {
    if (l.editingBy === input.localMachineId) continue;
    const key = `${l.workspaceId}::${l.posixRel}`;
    const chip: PresenceChip = {
      workspaceId: l.workspaceId,
      posixRel: l.posixRel,
      machineId: l.editingBy,
      machineName: l.editingByName ?? l.editingBy,
    };
    if (l.editingSince) {
      const t = Date.parse(l.editingSince);
      if (!Number.isNaN(t)) chip.ageSec = Math.max(0, Math.floor((nowMs - t) / 1000));
    }
    const arr = byFile.get(key) ?? [];
    if (arr.length < cap) arr.push(chip);
    byFile.set(key, arr);
  }
  for (const chips of byFile.values()) out.push(...chips);
  return out;
}

/** Sentinel: thrown by wiring layer when presence is requested but the
 *  real-time channel isn't ready yet (no signaling, no P2P). */
export class RemotePresenceNotReadyError extends Error {
  constructor(reason: string) {
    super(`RemotePresenceNotReady: ${reason}`);
    this.name = "RemotePresenceNotReadyError";
  }
}
