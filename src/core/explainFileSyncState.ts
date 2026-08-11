/**
 * v0.9 F-012 — pure trace builder for `vscodesync.explainFileSyncState`.
 *
 * Takes a snapshot of every gate the auto-sync pipeline consults for one
 * file and renders an ordered, human-readable check-list. Each item is
 * either:
 *   - `ok` — passed (won't block sync)
 *   - `block` — would block sync (the reason)
 *   - `info` — non-blocking observation (e.g. "no last sync recorded yet")
 *
 * No `vscode` import. The host gathers state and calls this; UI renders.
 */

export type ExplainItemKind = "ok" | "block" | "info";

export interface ExplainItem {
  /** Stable id for tests / future hyperlink anchors. */
  id: string;
  /** Bullet text shown to the user. */
  label: string;
  kind: ExplainItemKind;
  /** Optional hint — appears as a sub-line under the bullet. */
  hint?: string;
}

export interface ExplainFileSyncStateInput {
  workspaceRoot: string;
  posixRel: string;
  /** vscode.workspace.isTrusted */
  trusted: boolean;
  /** Resolved `vscodesync.autoSyncMode`. */
  autoSyncMode: "off" | "check-only";
  /** Session pause active. */
  sessionPaused: boolean;
  /** Auto-pause active (battery / metered). */
  autoPauseActive: boolean;
  /** Schedule gate blocking. */
  /** Provider rate-limit cooldown active. */
  rateLimited: boolean;
  /** Workspace exists in active set + state. */
  workspaceState: "active" | "suspended" | "frozen" | "missing";
  /** File tracked in `vscodesync.json`. */
  tracked: boolean;
  /** Current `syncStatus` field. */
  syncStatus?: "ok" | "conflict" | "pending_push" | "cloud_newer" | "missing_local";
  /** Soft-lock from another machine. */
  editingByOther?: { machineName: string };
  /** ISO of last successful sync — undefined if never. */
  lastSyncIso?: string;
  /** Read-only flag from secondary VS Code window. */
  secondaryReadOnly: boolean;
}

export interface ExplainFileSyncStateReport {
  posixRel: string;
  items: ExplainItem[];
  /** First `block` item — the proximate reason sync would not run. */
  primaryBlock?: ExplainItem;
  /** True if no `block` items — sync should run on next trigger. */
  willSync: boolean;
}

const itemOk = (id: string, label: string, hint?: string): ExplainItem => ({ id, label, kind: "ok", hint });
const itemBlock = (id: string, label: string, hint?: string): ExplainItem => ({ id, label, kind: "block", hint });
const itemInfo = (id: string, label: string, hint?: string): ExplainItem => ({ id, label, kind: "info", hint });

export function explainFileSyncState(input: ExplainFileSyncStateInput): ExplainFileSyncStateReport {
  const items: ExplainItem[] = [];

  // 1. Trust gate
  if (!input.trusted) {
    items.push(itemBlock("trust", "Workspace помечен Untrusted", "VS Code → Workspaces → Trust Workspace"));
  } else {
    items.push(itemOk("trust", "Workspace Trusted"));
  }

  // 2. Secondary read-only
  if (input.secondaryReadOnly) {
    items.push(itemBlock(
      "secondary_readonly",
      "Это окно VSCode в Read-only режиме (другое окно — основное)",
      "VSCodeSync: Take Sync Ownership чтобы стать основным",
    ));
  }

  // 3. autoSyncMode
  if (input.autoSyncMode === "off") {
    items.push(itemBlock("auto_mode", "Авто-режим: off", "Push/Pull только вручную"));
  } else {
    items.push(itemInfo(
      "auto_mode",
      "Авто-режим: check-only",
      "Авто-триггеры обновляют статус, но не двигают файлы. Push/Pull вручную.",
    ));
  }

  // 4. Pause / autopause / schedule / rate-limit
  if (input.sessionPaused) {
    items.push(itemBlock("session_pause", "Sync вручную приостановлен", "Снять паузу через статус-бар"));
  } else {
    items.push(itemOk("session_pause", "Сессионная пауза не активна"));
  }
  if (input.autoPauseActive) {
    items.push(itemBlock(
      "auto_pause",
      "Авто-пауза активна",
      "Низкий заряд батареи или лимитированное соединение",
    ));
  }
  if (input.rateLimited) {
    items.push(itemBlock(
      "rate_limit",
      "Провайдер ответил 429/503",
      "Авто-синхронизация на cooldown; ручные команды не блокируются",
    ));
  }

  // 5. Workspace state
  switch (input.workspaceState) {
    case "missing":
      items.push(itemBlock("ws_state", "Workspace не подключён локально", "Используйте Attach Cloud Workspace"));
      break;
    case "suspended":
      items.push(itemBlock("ws_state", "Workspace в режиме Suspend", "Resume через панель Workspaces"));
      break;
    case "frozen":
      items.push(itemBlock("ws_state", "Workspace заморожен (Freeze)", "Unfreeze через панель Workspaces"));
      break;
    case "active":
      items.push(itemOk("ws_state", "Workspace активен"));
      break;
  }

  // 6. File tracking
  if (!input.tracked) {
    items.push(itemBlock("tracked", "Файл не отслеживается", "VSCodeSync: Add Current File"));
  } else {
    items.push(itemOk("tracked", "Файл отслеживается"));
  }

  // 7. Status
  switch (input.syncStatus) {
    case "conflict":
      items.push(itemBlock(
        "status",
        "Файл в состоянии conflict",
        "Resolve через VSCodeSync: Resolve Conflicts (Keep Mine / Take Theirs / Keep Both)",
      ));
      break;
    case "pending_push":
      items.push(itemInfo("status", "Локальная версия новее облачной", "Отправьте через панель «Расхождения» или Push"));
      break;
    case "cloud_newer":
      items.push(itemInfo("status", "Облачная версия новее локальной", "Скачайте через панель «Расхождения» или Pull"));
      break;
    case "missing_local":
      items.push(itemInfo(
        "status",
        "Файл отслеживается, но отсутствует на диске",
        "Скачайте через панель «Расхождения» или привяжите к существующему файлу (VSCodeSync: Привязать локальный файл)",
      ));
      break;
    case "ok":
      items.push(itemOk("status", "Файл синхронизирован"));
      break;
    case undefined:
      items.push(itemInfo("status", "Статус не записан", "Будет установлен при следующей проверке"));
      break;
  }

  // 8. Soft lock from another machine
  if (input.editingByOther) {
    items.push(itemBlock(
      "soft_lock",
      `Soft-lock: ${input.editingByOther.machineName} сейчас редактирует этот файл`,
      "Push отключён до снятия lock. Ручной Pull доступен.",
    ));
  }

  // 9. Last sync info
  if (input.lastSyncIso) {
    items.push(itemInfo("last_sync", `Последний sync: ${input.lastSyncIso}`));
  } else {
    items.push(itemInfo("last_sync", "Этот файл ещё ни разу не синхронизировался"));
  }

  const primaryBlock = items.find((i) => i.kind === "block");
  return {
    posixRel: input.posixRel,
    items,
    primaryBlock,
    willSync: primaryBlock === undefined,
  };
}

/** Markdown rendering for the QuickPick description / webview body. Pure. */
export function formatExplainReportMarkdown(report: ExplainFileSyncStateReport): string {
  const lines: string[] = [];
  lines.push(`# Sync state — \`${report.posixRel}\``);
  lines.push("");
  if (report.willSync) {
    lines.push("✅ **Все проверки пройдены.** Авто-синхронизация выполнится при следующем триггере.");
  } else if (report.primaryBlock) {
    lines.push(`❌ **Главный блокер:** ${report.primaryBlock.label}`);
    if (report.primaryBlock.hint) {
      lines.push(`> ${report.primaryBlock.hint}`);
    }
  }
  lines.push("");
  lines.push("## Полный chain проверок");
  for (const it of report.items) {
    const icon = it.kind === "ok" ? "✓" : it.kind === "block" ? "✗" : "ℹ";
    lines.push(`- ${icon} ${it.label}`);
    if (it.hint) lines.push(`  - _${it.hint}_`);
  }
  return lines.join("\n");
}
