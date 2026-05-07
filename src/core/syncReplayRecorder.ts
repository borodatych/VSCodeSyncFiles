/**
 * Pure recorder/decoder for sync engine events. Lets a user record a
 * problematic sync session into a JSON file that can be replayed in dev for
 * debugging. The recorder itself just shapes events; persistence is wrapped
 * by the UI layer (atomic writes, gzip optional).
 *
 * Schema is versioned so recordings stay readable across releases.
 */

import type { ProviderType } from "./types.js";

export type ReplayEventKind =
  | "push"
  | "pull"
  | "conflict"
  | "manifest_write"
  | "manifest_412"
  | "skip";

export interface ReplayEvent {
  /** Monotonic step counter within this session (starts at 1). */
  step: number;
  /** Wall-clock ISO instant. */
  at: string;
  kind: ReplayEventKind;
  workspaceId: string;
  /** POSIX path; empty for manifest_*. */
  relPath: string;
  provider: ProviderType;
  /** Optional structured payload; small JSON snippet only — no file contents. */
  meta?: Record<string, string | number | boolean>;
}

export interface ReplaySession {
  schema: 1;
  /** ID generated at session start (not security-sensitive — random UUID is fine). */
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  /** Self-reported machine name; optional, for "shared with developer" UX. */
  machineName?: string;
  events: ReplayEvent[];
}

const SCHEMA_VERSION = 1 as const;
export const MAX_EVENTS = 10_000;

export function startReplaySession(
  sessionId: string,
  startedAt: string,
  machineName?: string,
): ReplaySession {
  return {
    schema: SCHEMA_VERSION,
    sessionId,
    startedAt,
    machineName,
    events: [],
  };
}

export function appendReplayEvent(
  session: ReplaySession,
  event: Omit<ReplayEvent, "step">,
): ReplaySession {
  const nextStep = session.events.length + 1;
  const ev: ReplayEvent = { ...event, step: nextStep };
  const events = session.events.length >= MAX_EVENTS
    ? [...session.events.slice(1), ev]
    : [...session.events, ev];
  return { ...session, events };
}

export function endReplaySession(session: ReplaySession, endedAt: string): ReplaySession {
  return { ...session, endedAt };
}

/** Strict validator — used by the replay loader; never throws. */
export function parseReplaySession(raw: unknown): ReplaySession | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as {
    schema?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    machineName?: unknown;
    events?: unknown;
  };
  if (obj.schema !== 1) return undefined;
  if (typeof obj.sessionId !== "string" || typeof obj.startedAt !== "string") return undefined;
  if (!Array.isArray(obj.events)) return undefined;
  const validKinds: ReadonlySet<string> = new Set([
    "push", "pull", "conflict", "manifest_write", "manifest_412", "skip",
  ]);
  const events: ReplayEvent[] = [];
  for (const e of obj.events as unknown[]) {
    if (typeof e !== "object" || e === null) continue;
    const x = e as {
      step?: unknown;
      at?: unknown;
      kind?: unknown;
      workspaceId?: unknown;
      relPath?: unknown;
      provider?: unknown;
      meta?: unknown;
    };
    if (
      typeof x.step !== "number" ||
      typeof x.at !== "string" ||
      typeof x.kind !== "string" ||
      typeof x.workspaceId !== "string" ||
      typeof x.relPath !== "string" ||
      typeof x.provider !== "string"
    ) continue;
    if (!validKinds.has(x.kind)) continue;
    events.push({
      step: x.step,
      at: x.at,
      kind: x.kind as ReplayEventKind,
      workspaceId: x.workspaceId,
      relPath: x.relPath,
      provider: x.provider as ProviderType,
      meta: x.meta as Record<string, string | number | boolean> | undefined,
    });
  }
  return {
    schema: 1,
    sessionId: obj.sessionId,
    startedAt: obj.startedAt,
    endedAt: typeof obj.endedAt === "string" ? obj.endedAt : undefined,
    machineName: typeof obj.machineName === "string" ? obj.machineName : undefined,
    events,
  };
}

export interface ReplaySummary {
  totalEvents: number;
  byKind: Record<ReplayEventKind, number>;
  workspaceCount: number;
  durationMs?: number;
}

export function summarizeReplay(session: ReplaySession): ReplaySummary {
  const byKind: Record<ReplayEventKind, number> = {
    push: 0, pull: 0, conflict: 0, manifest_write: 0, manifest_412: 0, skip: 0,
  };
  const workspaces = new Set<string>();
  for (const e of session.events) {
    byKind[e.kind]++;
    workspaces.add(e.workspaceId);
  }
  let durationMs: number | undefined;
  if (session.endedAt) {
    const a = Date.parse(session.startedAt);
    const b = Date.parse(session.endedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) durationMs = b - a;
  }
  return {
    totalEvents: session.events.length,
    byKind,
    workspaceCount: workspaces.size,
    durationMs,
  };
}
