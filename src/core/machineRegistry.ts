import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import { ProviderError } from "../providers/cloudProviderTypes.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "./syncWorkspaceInstanceReadOnly.js";
import type { MachineEntry } from "./cloudLayout.js";
import { machinesRegistryCloudPath } from "./cloudLayout.js";
import type { CurrentEditingFrame } from "./presenceCurrentEditing.js";

const REGISTRY_WRITE_RETRIES = 5;
const DEFAULT_PRUNE_DAYS = 90;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Parse cloud `_machines.json`. Throws if JSON is invalid for a registry. */
export function parseMachinesRegistry(buf: Buffer): MachineEntry[] {
  const t = buf.toString("utf8").trim();
  if (!t) {
    return [];
  }
  const data = JSON.parse(t) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("_machines.json must be a JSON array");
  }
  const out: MachineEntry[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const o = row as Record<string, unknown>;
    if (!isNonEmptyString(o.machineId) || !isNonEmptyString(o.machineName) || !isNonEmptyString(o.lastSeen)) {
      continue;
    }
    const e: MachineEntry = {
      machineId: o.machineId,
      machineName: o.machineName,
      lastSeen: o.lastSeen,
    };
    if (o.status === "active" || o.status === "pending" || o.status === "blocked") {
      e.status = o.status;
    }
    if (o.currentEditing === null) {
      e.currentEditing = null;
    } else if (o.currentEditing && typeof o.currentEditing === "object") {
      const ce = o.currentEditing as Record<string, unknown>;
      if (
        isNonEmptyString(ce.workspaceId) &&
        isNonEmptyString(ce.relPath) &&
        typeof ce.sinceMs === "number" &&
        Number.isFinite(ce.sinceMs)
      ) {
        e.currentEditing = {
          workspaceId: ce.workspaceId,
          relPath: ce.relPath,
          sinceMs: ce.sinceMs,
        };
      }
    }
    out.push(e);
  }
  return out;
}

export function serializeMachinesRegistry(entries: MachineEntry[]): Buffer {
  const body = `${JSON.stringify(entries, null, 2)}\n`;
  return Buffer.from(body, "utf8");
}

function nameTakenByOther(entries: MachineEntry[], name: string, selfId: string): boolean {
  return entries.some((e) => e.machineName === name && e.machineId !== selfId);
}

/**
 * Pick a display name not used by other machineIds. Same machineId may keep or change name freely.
 */
export function pickUniqueMachineName(entries: MachineEntry[], desired: string, selfMachineId: string): string {
  const base = desired.trim();
  if (!nameTakenByOther(entries, base, selfMachineId)) {
    return base;
  }
  let n = 2;
  for (;;) {
    const candidate = `${base}-${String(n)}`;
    if (!nameTakenByOther(entries, candidate, selfMachineId)) {
      return candidate;
    }
    n += 1;
  }
}

function pruneStaleEntries(entries: MachineEntry[], selfId: string, nowMs: number, maxAgeDays: number): MachineEntry[] {
  if (maxAgeDays <= 0) {
    return entries;
  }
  const cutoff = nowMs - maxAgeDays * 24 * 60 * 60 * 1000;
  return entries.filter((e) => {
    if (e.machineId === selfId) {
      return true;
    }
    const t = Date.parse(e.lastSeen);
    if (Number.isNaN(t)) {
      return true;
    }
    return t >= cutoff;
  });
}

export function upsertMachineAndPrune(
  entries: MachineEntry[],
  machineId: string,
  machineName: string,
  nowIso: string,
  pruneDays: number,
  nowMs: number,
  currentEditing?: CurrentEditingFrame | null,
): MachineEntry[] {
  const withoutSelf = entries.filter((e) => e.machineId !== machineId);
  const pruned = pruneStaleEntries(withoutSelf, machineId, nowMs, pruneDays);
  const self: MachineEntry = {
    machineId,
    machineName: machineName.trim(),
    lastSeen: nowIso,
  };
  if (currentEditing === null) {
    self.currentEditing = null;
  } else if (currentEditing !== undefined) {
    self.currentEditing = currentEditing;
  }
  return [...pruned, self];
}

/**
 * Download registry or [] if missing. Returns undefined on transient / read errors (caller may skip UX).
 */
export async function readMachinesRegistrySafe(provider: ICloudProvider): Promise<MachineEntry[] | undefined> {
  const cloudPath = machinesRegistryCloudPath();
  try {
    const res = await provider.downloadFile(cloudPath);
    if (res.notModified) {
      return [];
    }
    return parseMachinesRegistry(res.body);
  } catch (e) {
    if (e instanceof ProviderError && e.code === "NOT_FOUND") {
      return [];
    }
    return undefined;
  }
}

/**
 * Read-modify-write: upsert this machine and prune stale others. Retries on ETag conflict.
 */
export async function syncMachinesRegistrySelf(
  provider: ICloudProvider,
  machineId: string,
  machineName: string,
  opts?: { pruneDays?: number; nowMs?: number; currentEditing?: CurrentEditingFrame | null },
): Promise<void> {
  if (isSecondaryWorkspaceInstanceReadOnly()) {
    return;
  }
  const cloudPath = machinesRegistryCloudPath();
  const pruneDays = opts?.pruneDays ?? DEFAULT_PRUNE_DAYS;
  const nowMs = opts?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  for (let attempt = 0; attempt < REGISTRY_WRITE_RETRIES; attempt++) {
    let entries: MachineEntry[] = [];
    let etag: string | undefined;
    try {
      const res = await provider.downloadFile(cloudPath);
      if (!res.notModified && res.body.length > 0) {
        entries = parseMachinesRegistry(res.body);
      }
      etag = res.etag;
    } catch (e) {
      if (!(e instanceof ProviderError) || e.code !== "NOT_FOUND") {
        throw e;
      }
      entries = [];
      etag = undefined;
    }

    const merged = upsertMachineAndPrune(
      entries,
      machineId,
      machineName,
      nowIso,
      pruneDays,
      nowMs,
      opts?.currentEditing,
    );
    const body = serializeMachinesRegistry(merged);
    try {
      await provider.uploadFile(cloudPath, body, etag ? { ifMatch: etag } : {});
      return;
    } catch (e) {
      if (e instanceof ProviderError && e.code === "PRECONDITION_FAILED" && attempt + 1 < REGISTRY_WRITE_RETRIES) {
        continue;
      }
      throw e;
    }
  }
}

/**
 * Refresh this machine's row in a manifest's `machines[]` (extracted verbatim
 * from `syncEngine.touchMachine` — engine line-ceiling offset for Link
 * Bindings). A newly joining machine starts `pending` when approval is
 * required and others already exist; an existing row only bumps `lastSeen`.
 */
export function touchManifestMachine(
  machines: MachineEntry[],
  now: string,
  self: { machineId: string; machineName: string; requireApproval: boolean },
): MachineEntry[] {
  const byId = new Map(machines.map((m) => [m.machineId, { ...m }]));
  const cur = byId.get(self.machineId);
  if (cur) {
    cur.lastSeen = now;
  } else {
    const othersBeforeSelf = byId.size;
    const initialStatus: "pending" | "active" =
      self.requireApproval && othersBeforeSelf > 0 ? "pending" : "active";
    byId.set(self.machineId, {
      machineId: self.machineId,
      machineName: self.machineName,
      lastSeen: now,
      status: initialStatus,
    });
  }
  return [...byId.values()];
}
