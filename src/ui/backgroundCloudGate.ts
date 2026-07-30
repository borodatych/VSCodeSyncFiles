/**
 * The one question every background cloud poller must ask first (B11).
 *
 * `autoSyncMode: "off"` promises silence, but the connectivity probe kept
 * listing the cloud root every 30 seconds, the presence heartbeat kept
 * downloading and *uploading* `_machines.json`, and conflict prediction kept
 * fetching presence — all under "off". Beyond the broken promise, a 429 from
 * any of these armed the rate-limit gate that then blocked the manual
 * operations the user actually wanted.
 *
 * This is a gate on *polling*, not on mutation — the mutation checkpoint in
 * the engine is a separate, later question. Kept in `src/ui` because it reads
 * VS Code configuration.
 */
import * as vscode from "vscode";
import { isAutoCheckEnabled, parseAutoSyncMode } from "../core/autoSyncMode.js";
import { syncAutoPause } from "../core/syncAutoPause.js";
import { syncSessionPause } from "../core/syncSessionPause.js";
import { isSecondaryWorkspaceInstanceReadOnly } from "../core/syncWorkspaceInstanceReadOnly.js";

export function backgroundCloudAllowed(): boolean {
  if (!vscode.workspace.isTrusted) {
    return false;
  }
  const mode = parseAutoSyncMode(
    vscode.workspace.getConfiguration("vscodesync").get<string>("autoSyncMode", "check-only"),
  );
  if (!isAutoCheckEnabled(mode)) {
    return false;
  }
  if (syncSessionPause.isPaused() || syncAutoPause.isActive()) {
    return false;
  }
  if (isSecondaryWorkspaceInstanceReadOnly()) {
    return false;
  }
  return true;
}
