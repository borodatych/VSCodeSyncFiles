/**
 * Module-level recorder state for the manual sync-replay flow. Activates
 * when the user runs `vscodesync.startSyncRecording`; ingests every
 * `ActivityEventInput` until `vscodesync.stopSyncRecording`. Persists the
 * resulting JSON next to `activity.json` for sharing.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { writeTextFileAtomic } from "../core/writeTextFileAtomic.js";
import {
  appendReplayEvent,
  endReplaySession,
  startReplaySession,
  type ReplaySession,
  type ReplayEventKind,
} from "../core/syncReplayRecorder.js";
import type { ActivityEventInput } from "../core/activityLog.js";

let active: ReplaySession | undefined;
let outputDir = "";

const FILE_PREFIX = "replay-";

function activityKindToReplayKind(kind: ActivityEventInput["kind"]): ReplayEventKind | undefined {
  if (kind === "push" || kind === "pull" || kind === "conflict") return kind;
  if (kind === "resolve_keep_mine" || kind === "resolve_take_theirs") return "skip";
  return undefined;
}

export function startRecording(storageDir: string, machineName: string): { sessionId: string } {
  outputDir = storageDir;
  const sessionId = randomUUID();
  active = startReplaySession(sessionId, new Date().toISOString(), machineName);
  return { sessionId };
}

export function isRecording(): boolean {
  return active !== undefined;
}

export function feedActivity(ev: ActivityEventInput): void {
  if (!active) return;
  const kind = activityKindToReplayKind(ev.kind);
  if (!kind) return;
  active = appendReplayEvent(active, {
    at: new Date().toISOString(),
    kind,
    workspaceId: ev.workspaceId,
    relPath: ev.relPath,
    provider: ev.provider,
  });
}

export async function stopRecording(): Promise<string | undefined> {
  if (!active) return undefined;
  const session = endReplaySession(active, new Date().toISOString());
  active = undefined;
  if (!outputDir) return undefined;
  const fp = path.join(outputDir, `${FILE_PREFIX}${session.sessionId}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  await writeTextFileAtomic(fp, `${JSON.stringify(session, null, 2)}\n`);
  return fp;
}
