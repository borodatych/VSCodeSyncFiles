/**
 * VS Code side of `backgroundPollProfile`: reads the setting and hands pollers
 * a ready interval. Kept out of `core/` so the policy itself stays testable
 * without an editor.
 */
import * as vscode from "vscode";
import {
  parseBackgroundPollProfile,
  pollIntervalMs,
  type BackgroundPollProfile,
} from "../core/backgroundPollProfile.js";

export const POLL_PROFILE_SETTING = "vscodesync.background.pollProfile";

export function currentBackgroundPollProfile(): BackgroundPollProfile {
  return parseBackgroundPollProfile(
    vscode.workspace.getConfiguration("vscodesync").get<string>("background.pollProfile", "normal"),
  );
}

/** Interval for a poller with the given tuned base; `null` means "do not arm". */
export function currentPollIntervalMs(baseMs: number): number | null {
  return pollIntervalMs(baseMs, currentBackgroundPollProfile());
}

/**
 * Re-arm a poller when the profile changes.
 *
 * Without this the setting would only take effect after a window reload, which
 * is precisely when the user is least inclined to believe it did anything.
 */
export function onBackgroundPollProfileChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(POLL_PROFILE_SETTING)) {
      listener();
    }
  });
}
