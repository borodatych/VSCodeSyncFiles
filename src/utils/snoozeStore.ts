/**
 * Thin namespaced wrapper around `vscode.ExtensionContext.globalState` for
 * the "snooze map" pattern: a `Record<string, string>` keyed by some
 * caller-defined entry id, where values are ISO timestamps (or sentinel
 * strings like `__never`) telling the UI to skip the prompt for a while.
 *
 * Three UI flows used to inline identical helpers:
 *   - `workspaceInactiveArchive.ts`        (single namespace)
 *   - `smartWorkspaceSuggestions.ts`       (multiple namespaces — coedit / early-archive)
 *   - `machineApprovalNotifications.ts`    (single namespace, no `__never` support)
 *
 * The decision logic ("is this snooze still active?") lives in
 * `core/inactiveWorkspaceCandidates.ts:isInactiveSnoozeActive` (pure). This
 * module only owns the IO surface — `globalState.get` / `globalState.update`.
 */

import type * as vscode from "vscode";

/** Read the snooze map for one namespace. Returns an empty object when the
 *  key has never been written (vscode `get` returns `undefined`). */
export function readSnoozeMap(
  ctx: vscode.ExtensionContext,
  namespaceKey: string,
): Record<string, string> {
  return ctx.globalState.get<Record<string, string>>(namespaceKey) ?? {};
}

/** Insert / replace / remove one entry inside a namespace.
 *  - `value: string` — write; commonly an ISO timestamp or a sentinel.
 *  - `value: undefined` — drop the entry from the map.
 *
 * Implemented as read-modify-write because vscode's `globalState` doesn't
 * expose a "patch entry" API. */
export async function setSnoozeEntry(
  ctx: vscode.ExtensionContext,
  namespaceKey: string,
  entryKey: string,
  value: string | undefined,
): Promise<void> {
  const prev = readSnoozeMap(ctx, namespaceKey);
  const next =
    value === undefined
      ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== entryKey))
      : { ...prev, [entryKey]: value };
  await ctx.globalState.update(namespaceKey, next);
}
