import * as vscode from "vscode";
import { isWithinSyncSchedule, normalizeSyncSchedule } from "../core/syncSchedule.js";

const CFG = "vscodesync";

export function getWorkspaceSyncScheduleNormalized(): ReturnType<typeof normalizeSyncSchedule> {
  const raw = vscode.workspace.getConfiguration(CFG).get("syncSchedule");
  return normalizeSyncSchedule(raw);
}

/** True when `syncSchedule.enabled` and current wall-clock is outside the active window (automatic sync should not run). */
export function isAutoSyncBlockedBySchedule(): boolean {
  const s = getWorkspaceSyncScheduleNormalized();
  return s.enabled && !isWithinSyncSchedule(s);
}
