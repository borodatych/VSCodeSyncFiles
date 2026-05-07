import * as vscode from "vscode";
import { formatNotification } from "../utils/notificationFormat.js";

const CFG_SECTION = "vscodesync";

export type NotificationLevel = "minimal" | "normal" | "verbose";

const LEVEL_RANK: Record<NotificationLevel, number> = {
  minimal: 0,
  normal: 1,
  verbose: 2,
};

function getLevel(): NotificationLevel {
  const raw = vscode.workspace
    .getConfiguration(CFG_SECTION)
    .get<string>("notificationLevel", "normal");
  if (raw === "minimal" || raw === "normal" || raw === "verbose") {
    return raw;
  }
  return "normal";
}

function meetsLevel(minLevel: NotificationLevel): boolean {
  return LEVEL_RANK[getLevel()] >= LEVEL_RANK[minLevel];
}

function getDigestIntervalMin(): number {
  // WorkspaceConfiguration.get<T> with a default always returns T, never undefined
  return vscode.workspace.getConfiguration(CFG_SECTION).get("digestIntervalMinutes", 30);
}

// ---------------------------------------------------------------------------
// Digest buffer
// ---------------------------------------------------------------------------

interface DigestBucket {
  pushed: number;
  pulled: number;
  conflicts: number;
  fromMachines: Set<string>;
}

let digestBucket: DigestBucket = {
  pushed: 0,
  pulled: 0,
  conflicts: 0,
  fromMachines: new Set(),
};

function resetBucket(): void {
  digestBucket = {
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    fromMachines: new Set(),
  };
}

function bucketIsEmpty(): boolean {
  return digestBucket.pushed === 0 && digestBucket.pulled === 0 && digestBucket.conflicts === 0;
}

function flushDigest(): void {
  if (bucketIsEmpty()) {
    return;
  }
  const level = getLevel();
  if (level === "minimal" || level === "verbose") {
    resetBucket();
    return;
  }

  const parts: string[] = [];
  if (digestBucket.pulled > 0) {
    const from = digestBucket.fromMachines.size > 0 ? ` с '${[...digestBucket.fromMachines].join(", ")}'` : "";
    parts.push(`↓ ${String(digestBucket.pulled)} файл(ов) обновлено${from}`);
  }
  if (digestBucket.pushed > 0) {
    parts.push(`✅ ${String(digestBucket.pushed)} файл(ов) запушено`);
  }
  if (digestBucket.conflicts > 0) {
    parts.push(`⚠ ${String(digestBucket.conflicts)} конфликт(ов)`);
  } else {
    parts.push("0 конфликтов");
  }

  const intervalMin = getDigestIntervalMin();
  resetBucket();

  void vscode.window
    .showInformationMessage(
      formatNotification(`☁ VSCodeSync — за последние ${String(intervalMin)} мин:\n  ${parts.join("\n  ")}`),
      "Показать детали",
      "Закрыть",
    )
    .then((choice) => {
      if (choice === "Показать детали") {
        void vscode.commands.executeCommand("vscodesync.openActivityFeed");
      }
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Show info message filtered by notification level.
 * @param minLevel Minimum level required to show the message (default "normal").
 */
export async function showSyncInfo(
  msg: string,
  minLevel: NotificationLevel = "normal",
  ...actions: string[]
): Promise<string | undefined> {
  if (!meetsLevel(minLevel)) {
    return undefined;
  }
  return vscode.window.showInformationMessage(formatNotification(msg), ...actions);
}

/**
 * Show warning filtered by notification level.
 * Conflicts (isConflict=true) bypass the level filter and always show.
 */
export async function showSyncWarning(
  msg: string,
  minLevel: NotificationLevel = "normal",
  options?: { isConflict?: boolean; actions?: string[] },
): Promise<string | undefined> {
  const isConflict = options?.isConflict ?? false;
  const actions = options?.actions ?? [];
  if (!isConflict && !meetsLevel(minLevel)) {
    return undefined;
  }
  return vscode.window.showWarningMessage(formatNotification(msg), ...actions);
}

/**
 * Show error — always shown regardless of notification level.
 */
export async function showSyncError(msg: string, ...actions: string[]): Promise<string | undefined> {
  return vscode.window.showErrorMessage(formatNotification(msg), ...actions);
}

/**
 * Record a push event for the digest buffer.
 * In verbose mode or digestIntervalMinutes=0: shows immediately.
 * In normal mode: accumulates for batch digest.
 * In minimal mode: silently ignores.
 */
export function recordDigestPush(count: number, machineName?: string): void {
  const level = getLevel();
  if (level === "minimal") {
    return;
  }
  const intervalMin = getDigestIntervalMin();
  if (level === "verbose" || intervalMin === 0) {
    const to = machineName ? ` → ${machineName}` : "";
    void vscode.window.showInformationMessage(formatNotification(`VSCodeSync: ↑ push ${String(count)} файл(ов)${to}`));
    return;
  }
  digestBucket.pushed += count;
  if (machineName) {
    digestBucket.fromMachines.add(machineName);
  }
}

/**
 * Record a pull event for the digest buffer.
 * In verbose mode or digestIntervalMinutes=0: shows immediately.
 * In normal mode: accumulates for batch digest.
 * In minimal mode: silently ignores.
 */
export function recordDigestPull(count: number, fromMachine?: string): void {
  const level = getLevel();
  if (level === "minimal") {
    return;
  }
  const intervalMin = getDigestIntervalMin();
  if (level === "verbose" || intervalMin === 0) {
    const from = fromMachine ? ` ← ${fromMachine}` : "";
    void vscode.window.showInformationMessage(formatNotification(`VSCodeSync: ↓ pull ${String(count)} файл(ов)${from}`));
    return;
  }
  digestBucket.pulled += count;
  if (fromMachine) {
    digestBucket.fromMachines.add(fromMachine);
  }
}

/**
 * Record a conflict — always shows immediately regardless of level or digest.
 * Also increments the conflict counter in the buffer for digest summary.
 */
export function recordDigestConflict(fileName: string): void {
  digestBucket.conflicts += 1;

  void vscode.window
    .showWarningMessage(
      formatNotification(`VSCodeSync: ⚠ конфликт — ${fileName}. Разрешите вручную.`),
      "Открыть Activity Feed",
    )
    .then((choice) => {
      if (choice === "Открыть Activity Feed") {
        void vscode.commands.executeCommand("vscodesync.openActivityFeed");
      }
    });
}

/**
 * Start the periodic digest timer. Call once on extension activation.
 * The timer reschedules itself using the current config value, so changing
 * digestIntervalMinutes takes effect on the next tick.
 */
export function startDigestTimer(context: vscode.ExtensionContext): void {
  const scheduleNext = (): ReturnType<typeof setTimeout> => {
    const ms = Math.max(5, getDigestIntervalMin()) * 60 * 1000;
    return setTimeout(() => {
      flushDigest();
      handle = scheduleNext();
    }, ms);
  };

  let handle = scheduleNext();

  context.subscriptions.push(
    new vscode.Disposable(() => {
      clearTimeout(handle);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG_SECTION}.digestIntervalMinutes`)) {
        clearTimeout(handle);
        handle = scheduleNext();
      }
    }),
  );
}
