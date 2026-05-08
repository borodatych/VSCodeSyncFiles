import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";
import { randomUUID } from "node:crypto";
import type { ProviderType } from "./types.js";

const ACTIVITY_FILE = "activity.json";
const MAX_EVENTS = 50_000;

export type ActivityKind =
  | "push"
  | "pull"
  | "conflict"
  | "add"
  | "remove"
  | "resolve_keep_mine"
  | "resolve_take_theirs"
  | "hash_migration"
  // v3 events emitted by future engine wiring; pre-registered so the
  // pure planners (v3.B/D/I/K/L) can reference these kinds without a
  // schema bump later. Forward-compat: old activity-log readers tolerate
  // unknown kinds (they render as raw strings).
  | "branch_mismatch_detected"
  | "key_rotation_started"
  | "key_rotation_completed"
  | "key_rotation_resumed"
  | "backup_verified"
  | "backup_drift_detected"
  | "quota_warning"
  | "quota_critical"
  | "quota_auto_pause"
  | "share_link_used";

/** Payload recorded by SyncEngine or extension UI (before id/timestamp). */
export interface ActivityEventInput {
  kind: ActivityKind;
  workspaceId: string;
  workspaceNote: string;
  relPath: string;
  machineName: string;
  provider: ProviderType;
  detail?: string;
  meta?: Record<string, unknown>;
}

export interface ActivityEvent extends ActivityEventInput {
  id: string;
  at: string;
}

export interface ActivityFileV1 {
  schema: 1;
  events: ActivityEvent[];
}

export function activityFilePath(storageDir: string): string {
  return path.join(storageDir, ACTIVITY_FILE);
}

export async function loadActivityFile(storageDir: string): Promise<ActivityFileV1> {
  const fp = activityFilePath(storageDir);
  try {
    const raw = await fs.readFile(fp, "utf8");
    const data = JSON.parse(raw) as Partial<ActivityFileV1>;
    if (data.schema !== 1 || !Array.isArray(data.events)) {
      return { schema: 1, events: [] };
    }
    return { schema: 1, events: data.events };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: 1, events: [] };
    }
    throw e;
  }
}

function pruneByAge(events: ActivityEvent[], retentionDays: number): ActivityEvent[] {
  if (retentionDays <= 0) {
    return events;
  }
  const cutoff = Date.now() - retentionDays * 86_400_000;
  return events.filter((ev) => {
    const t = Date.parse(ev.at);
    return !Number.isNaN(t) && t >= cutoff;
  });
}

/**
 * Append one event and persist. Applies rolling retention by `at` (drops older than N days).
 */
export async function appendActivityEvent(
  storageDir: string,
  input: ActivityEventInput,
  retentionDays: number,
): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const fp = activityFilePath(storageDir);
  const file = await loadActivityFile(storageDir);
  file.events = pruneByAge(file.events, retentionDays);
  const event: ActivityEvent = {
    ...input,
    id: randomUUID(),
    at: new Date().toISOString(),
  };
  file.events.push(event);
  if (file.events.length > MAX_EVENTS) {
    file.events = file.events.slice(-MAX_EVENTS);
  }
  await writeTextFileAtomic(fp, `${JSON.stringify(file, null, 2)}\n`);
}
