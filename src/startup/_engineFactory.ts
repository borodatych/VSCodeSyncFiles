/**
 * Engine factory — extracted from `extension.ts` (Phase 0 / v2.11.1).
 *
 * Encapsulates the `makeEngine` closure together with its 6 dedup `Set<string>`
 * stores and 5 callback refs that previously lived as module-level state in
 * `extension.ts`. Each `createEngineFactory()` call yields a self-contained
 * factory whose dedup sets are isolated from any other factory — important
 * for tests and for multi-window safety.
 *
 * The contract is intentionally narrow:
 *   - `makeEngine(root, provider, machineId, machineName, encKey?)` →
 *     `SyncEngine`. Reads the current `vscode` workspace configuration on
 *     every call (matches the old behaviour).
 *   - `setRefs(refs)` lets `activate()` plug in the activity / stats /
 *     compression / tree-refresh / repush callbacks once they exist.
 *   - `notifiedConflictKeys` is exposed because `registerConflictsCommands`
 *     shares it with the engine's `onNewConflict` notifier.
 */
import * as vscode from "vscode";
import { encryptBuffer, decryptBuffer } from "../core/encryption.js";
import { SyncEngine } from "../core/syncEngine.js";
import type { PurgeLostFileItem, SyncProfileSample } from "../core/syncEngine.js";
import { wrapWithQueue } from "../core/queuedProvider.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { ActiveWorkspaceEntry, TrackedFile } from "../core/types.js";
import type { ActivityEventInput } from "../core/activityLog.js";
import type { SyncTransferEvent } from "../core/syncStatsStore.js";
import type { LineEndingMode } from "../utils/normalize.js";
import { createSyncProfileBuffer, type SyncProfileBuffer } from "../core/syncProfileBuffer.js";
import { decideAdaptiveConcurrency } from "../core/adaptiveConcurrency.js";
import { isAutoSyncBlockedByRateLimit } from "../core/syncRateLimitState.js";
import { resolveSettingWithRc } from "../core/vscodesyncRc.js";
import { getVscodesyncRcFor } from "../ui/vscodesyncRcWatcher.js";

const CFG_SECTION = "vscodesync";

/**
 * v0.18 W4 — gather best-effort pressure signals available without OS
 * permission prompts. Battery / CPU / RAM aren't directly exposed by the
 * VS Code extension API on web; on desktop we use `process` and the
 * `os` module where available.
 */
function readPressureSignals(): {
  batteryPercent?: number;
  pluggedIn?: boolean;
  ramRatio?: number;
  rateLimited?: boolean;
  cpuHigh?: boolean;
} {
  const out: ReturnType<typeof readPressureSignals> = {};
  out.rateLimited = isAutoSyncBlockedByRateLimit();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    const total = os.totalmem();
    const free = os.freemem();
    if (total > 0) out.ramRatio = (total - free) / total;
  } catch { /* web / sandboxed — skip */ }
  // Battery API isn't available on Node without a native dep; we leave
  // it undefined so `decideAdaptiveConcurrency` just bypasses that arm.
  return out;
}

export interface EngineFactoryRefs {
  logSyncActivity?: (ev: ActivityEventInput) => void;
  logSyncStatsTransfer?: (ev: SyncTransferEvent) => void;
  logSyncCompression?: (saved: number) => void;
  treeRefresh?: () => void;
  repushDeletedWorkspace?: (
    workspaceId: string,
    localRoot: string,
    savedEntry: ActiveWorkspaceEntry,
    savedFiles: TrackedFile[],
  ) => Promise<void>;
  /** v2.12.4 — best-effort P2P mirror for `pushFile`. */
  mirrorPushedFile?: (workspaceId: string, posixRel: string, plaintext: Buffer) => void;
}

export interface EngineFactoryDeps {
  /** Active encryption key, or null when `vscodesync.encryption` is off. */
  getEncKey: () => Promise<Buffer | null>;
}

export interface EngineFactory {
  readonly makeEngine: (
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ) => SyncEngine;
  /**
   * Re-read the encryption key into the factory cache. Must be awaited during
   * activation and after anything that changes the key or the setting.
   *
   * The key used to be an optional fifth argument of `makeEngine`, and 17 of
   * the 24 construction sites simply did not pass it — six of them could not,
   * the parameter was missing from their dependency type. Owning the key here
   * removes the choice from the call site entirely.
   */
  readonly refreshEncryptionKey: () => Promise<void>;
  readonly setRefs: (refs: EngineFactoryRefs) => void;
  /** Shared with `registerConflictsCommands` — bundle clears entries on resolve. */
  readonly notifiedConflictKeys: Set<string>;
  /** v0.7 — shared profile buffer (used by `vscodesync.profileSync` command). */
  readonly profileBuffer: SyncProfileBuffer;
}

function syncWarnDedupeKey(workspaceRoot: string, segment: string, rel: string): string {
  return `${workspaceRoot}\u0000${segment}\u0000${rel}`;
}

function buildInlineDiff(oldText: string, newText: string, maxLines = 20): string | null {
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const out: string[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i += 1) {
    const a = oldLines[i] ?? "";
    const b = newLines[i] ?? "";
    if (a === b) continue;
    if (a.length > 0) out.push(`- ${a}`);
    if (b.length > 0) out.push(`+ ${b}`);
    if (out.length >= maxLines) {
      out.push("...");
      break;
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

function makeOnFilePulledCallback(): (
  posixRel: string,
  oldContent: string | null,
  newContent: string,
) => void {
  return (posixRel, oldContent, newContent): void => {
    const level = vscode.workspace
      .getConfiguration(CFG_SECTION)
      .get<string>("notificationLevel", "normal");
    if (level !== "verbose") return;
    const diff = buildInlineDiff(oldContent ?? "", newContent);
    const fileName = posixRel.split("/").pop() ?? posixRel;
    if (diff !== null) {
      void vscode.window.showInformationMessage(`VSCodeSync: ↓ ${fileName}\n${diff}`);
    } else {
      void vscode.window.showInformationMessage(`VSCodeSync: ↓ ${fileName} обновлён`);
    }
  };
}

export function createEngineFactory(factoryDeps: EngineFactoryDeps): EngineFactory {
  /** Cached encryption key; refreshed via `refreshEncryptionKey`. */
  let cachedEncKey: Buffer | null = null;

  const refreshEncryptionKey = async (): Promise<void> => {
    cachedEncKey = await factoryDeps.getEncKey();
  };

  const warnedEncodingIssueKeys = new Set<string>();
  const warnedPreserveLfConflictKeys = new Set<string>();
  const warnedPurgeLostKeys = new Set<string>();
  const warnedSchemaVersionKeys = new Set<string>();
  const warnedCorruptManifestKeys = new Set<string>();
  const warnedRemoteDeletedKeys = new Set<string>();
  const notifiedConflictKeys = new Set<string>();
  const profileBuffer = createSyncProfileBuffer({ capacity: 500 });

  let refs: EngineFactoryRefs = {};

  function makeEngine(
    workspaceRoot: string,
    provider: ICloudProvider,
    machineId: string,
    machineName: string,
  ): SyncEngine {
    const cfg = vscode.workspace.getConfiguration(CFG_SECTION);
    const mb = cfg.get<number>("maxFileSizeMB", 5);
    const maxB = Math.max(0, mb) * 1024 * 1024;
    const leRaw = cfg.get<string>("lineEnding", "lf");
    const lineEnding: LineEndingMode =
      leRaw === "crlf" || leRaw === "preserve" ? leRaw : "lf";
    const localBackupEnabled = cfg.get<boolean>("localBackupEnabled", true);
    const localBackupRetentionDays = cfg.get<number>("localBackupRetentionDays", 7);
    // The engine already accepted `tombstonePurgeDays` and a user-facing warning
    // quoted its value, but nothing ever passed it and the setting was not even
    // declared — the number in that warning was always the hardcoded 30.
    const tombstonePurgeDays = cfg.get<number>("tombstonePurgeDays", 30);
    const encryptionOn = cfg.get<boolean>("encryption", false);
    const compressUploads = cfg.get<boolean>("compressUploads", false);
    const key = encryptionOn ? cachedEncKey : null;
    return new SyncEngine({
      workspaceRoot,
      provider: wrapWithQueue(provider),
      machineId,
      machineName,
      maxFileSizeBytes: maxB > 0 ? maxB : undefined,
      lineEnding,
      // VSCodeSync v1 supports UTF-8 only; surface BOM / invalid UTF-8.
      encodingLint: true,
      localBackupEnabled,
      localBackupRetentionDays,
      tombstonePurgeDays,
      // `encryptionRequired` lets the engine refuse when the setting is on but
      // the key is absent, instead of silently working in plaintext.
      encryptionRequired: encryptionOn,
      encrypt: key ? (buf) => encryptBuffer(key, buf) : undefined,
      decrypt: key ? (buf) => decryptBuffer(key, buf) : undefined,
      onFilePulled: makeOnFilePulledCallback(),
      onEncodingIssue: (kind, rel) => {
        const k = syncWarnDedupeKey(workspaceRoot, kind, rel);
        if (warnedEncodingIssueKeys.has(k)) {
          return;
        }
        warnedEncodingIssueKeys.add(k);
        const tip =
          kind === "bom"
            ? `UTF-8 BOM в «${rel}» исключается из канона; сохраните файл без BOM для предсказуемости.`
            : `«${rel}»: недопустимые UTF‑8 последовательности; канон использует замену символов.`;
        void vscode.window.showWarningMessage(`VSCodeSync: ${tip}`);
      },
      onPreserveLineEndingConflictHint:
        lineEnding === "preserve"
          ? (rel) => {
              const k = syncWarnDedupeKey(workspaceRoot, "preserve-le", rel);
              if (warnedPreserveLfConflictKeys.has(k)) {
                return;
              }
              warnedPreserveLfConflictKeys.add(k);
              void vscode.window.showWarningMessage(
                `VSCodeSync: возможный конфликт только из‑за переводов строк («${rel}»). При lineEnding=preserve хэш зависит от CR/LF; рассмотрите lf или crlf.`,
              );
            }
          : undefined,
      requireMachineApproval: () =>
        vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("requireMachineApproval", false),
      canonicalHashAlgo: () => {
        const raw = vscode.workspace
          .getConfiguration(CFG_SECTION)
          .get<string>("canonicalHashAlgo", "sha256");
        return raw === "blake3" || raw === "dual" ? raw : "sha256";
      },
      onPushFile: (workspaceId, posixRel, plaintext) => {
        refs.mirrorPushedFile?.(workspaceId, posixRel, plaintext);
      },
      onSyncActivity: (ev) => {
        refs.logSyncActivity?.(ev);
      },
      onTransfer: (ev) => {
        refs.logSyncStatsTransfer?.(ev);
      },
      compressUploads: compressUploads && !encryptionOn,
      onCompressionSaving: (saved) => {
        refs.logSyncCompression?.(saved);
      },
      deltaSync: cfg.get<boolean>("deltaSync", false),
      deltaThresholdKB: cfg.get<number>("deltaThresholdKB", 100),
      // v0.7 — performance / safety knobs read live from settings so changes
      // take effect without rebuilding the engine.
      syncFileConcurrency: (): number => {
        // v0.18 W6 — `.vscodesyncrc.json` may override `sync.concurrency`
        // for the current workspace folder; fall back to VS Code setting.
        const rc = getVscodesyncRcFor(workspaceRoot);
        const vscodeVal = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("sync.concurrency", 4);
        const user = resolveSettingWithRc<number>("sync.concurrency", rc, vscodeVal);
        // v0.18 W4 — apply adaptive multiplier on read so each call picks
        // up live system pressure without engine rebuild.
        const decision = decideAdaptiveConcurrency(readPressureSignals(), { userConcurrency: user });
        return decision.resolvedConcurrency;
      },
      syncWorkspaceConcurrency: () => {
        const rc = getVscodesyncRcFor(workspaceRoot);
        const vscodeVal = vscode.workspace.getConfiguration(CFG_SECTION).get<number>("sync.workspaceConcurrency", 2);
        return resolveSettingWithRc<number>("sync.workspaceConcurrency", rc, vscodeVal);
      },
      verifyUploadHash: () => {
        const raw = vscode.workspace
          .getConfiguration(CFG_SECTION)
          .get<string>("verifyUploadHash", "plaintext-only");
        return raw === "never" ? "never" : "plaintext-only";
      },
      providerHashVerify: () =>
        vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("providerHashVerify", false),
      isTrustedTeammate: (mid: string) => {
        // v0.18 D06 — read trusted-machines registry from a global cache
        // populated by `trustedTeammatesUi.ts`. Pure-helper-shape lookup.
        const raw = (globalThis as { __vscodesyncTrustedMidsCache?: Set<string> }).__vscodesyncTrustedMidsCache;
        return raw?.has(mid) ?? false;
      },
      historyVersions: () =>
        vscode.workspace.getConfiguration(CFG_SECTION).get<number>("historyVersions", 10),
      historyMode: () => {
        const raw = vscode.workspace
          .getConfiguration(CFG_SECTION)
          .get<string>("historyMode", "inline");
        return raw === "lazy" ? "lazy" : raw === "off" ? "off" : "inline";
      },
      metaWriteRetries: () =>
        vscode.workspace.getConfiguration(CFG_SECTION).get<number>("metaWriteRetries", 3),
      verifyRetries: () =>
        vscode.workspace.getConfiguration(CFG_SECTION).get<number>("verifyRetries", 3),
      softLockStaleMs: () =>
        Math.max(1, vscode.workspace.getConfiguration(CFG_SECTION).get<number>("softLockStaleHours", 3)) *
        3600_000,
      localBackupDir: () =>
        vscode.workspace
          .getConfiguration(CFG_SECTION)
          .get<string>("localBackupDir", ".vscode/vscodesync-local-backup"),
      onSyncProfileSample: (sample: SyncProfileSample) => {
        // Only collect when the user opted in. Cheap path otherwise.
        if (vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("diagnostics.profileSync", false)) {
          profileBuffer.push(sample);
        }
      },
      onPurgeLostFiles: (items: PurgeLostFileItem[]) => {
        const fresh = items.filter((i) => {
          const k = `${i.workspaceId}:${i.relPath}`;
          if (warnedPurgeLostKeys.has(k)) {
            return false;
          }
          warnedPurgeLostKeys.add(k);
          return true;
        });
        if (fresh.length === 0) {
          return;
        }
        const label =
          fresh.length === 1
            ? `«${fresh[0]?.relPath ?? ""}»`
            : `${String(fresh.length)} файлов`;
        void vscode.window
          .showWarningMessage(
            `VSCodeSync: ${label} потерял(и) синхронизацию — файл был удалён другой машиной пока вы были офлайн, и tombstone уже очищен (>${String(vscode.workspace.getConfiguration(CFG_SECTION).get<number>("tombstonePurgeDays", 30))} дней).`,
            "Подробнее",
          )
          .then((choice) => {
            if (choice !== "Подробнее") {
              return;
            }
            const ch = vscode.window.createOutputChannel("VSCodeSync: Потерянные файлы");
            ch.appendLine(
              "Файлы отслеживались в VSCodeSync, но tombstone в манифесте уже очищен.",
            );
            ch.appendLine(
              "Это означает: файл удалён другой машиной более tombstonePurgeDays дней назад.",
            );
            ch.appendLine(
              "Локальная копия на диске НЕ удалена — она просто больше не синхронизируется.",
            );
            ch.appendLine("");
            for (const item of fresh) {
              ch.appendLine(`  Workspace : ${item.workspaceNote} (${item.workspaceId})`);
              ch.appendLine(`  Файл      : ${item.relPath}`);
              ch.appendLine("");
            }
            ch.appendLine(
              "Для восстановления синхронизации: VSCodeSync: Add Current File → выберите workspace.",
            );
            ch.show();
          });
      },
      onNewConflict: (workspaceId: string, workspaceNote: string, relPath: string, isBinary: boolean) => {
        const k = `${workspaceId}:${relPath}`;
        if (notifiedConflictKeys.has(k)) {
          return;
        }
        notifiedConflictKeys.add(k);
        const basename = relPath.split("/").pop() ?? relPath;
        const wsLabel = workspaceNote || workspaceId;
        const msgPrefix = isBinary
          ? `VSCodeSync ⚠ Конфликт бинарного файла «${basename}» в workspace «${wsLabel}».`
          : `VSCodeSync ⚠ Конфликт «${basename}» в workspace «${wsLabel}».`;
        void vscode.window
          .showWarningMessage(`${msgPrefix} Разрешите через боковую панель или «VSCodeSync: Resolve Conflicts».`, "Resolve Now")
          .then((choice) => {
            if (choice === "Resolve Now") {
              void vscode.commands.executeCommand("vscodesync.resolveConflicts");
            }
          });
      },
      onSchemaVersionTooNew: (workspaceId: string, detectedVersion: number) => {
        if (warnedSchemaVersionKeys.has(workspaceId)) {
          return;
        }
        warnedSchemaVersionKeys.add(workspaceId);
        void vscode.window.showWarningMessage(
          `VSCodeSync: workspace ${workspaceId} использует schemaVersion ${String(detectedVersion)}, которую эта версия расширения не поддерживает (поддерживается v${String(1)}). Синхронизация приостановлена для этого workspace. Обновите расширение VSCodeSync.`,
          "Проверить обновления",
        ).then((choice) => {
          if (choice === "Проверить обновления") {
            void vscode.commands.executeCommand("workbench.extensions.search", "vscodesync");
          }
        });
      },
      // v0.7 W3 — schema mismatch on attach. Default behaviour: abort
      // (engine throws as before). Future versions will offer "migrate"
      // when a coordinated migration plan exists.
      onSchemaVersionMismatch: async (
        workspaceId: string,
        detectedVersion: number,
        supportedVersion: number,
      ): Promise<"migrate" | "abort"> => {
        await vscode.window.showWarningMessage(
          `VSCodeSync: workspace ${workspaceId} имеет schemaVersion ${String(detectedVersion)}, ожидалась v${String(supportedVersion)}. Подключение отменено. Обновите расширение или удалите workspace на облаке.`,
        );
        return "abort";
      },
      onCorruptManifest: (workspaceId: string, reason: string) => {
        if (warnedCorruptManifestKeys.has(workspaceId)) {
          return;
        }
        warnedCorruptManifestKeys.add(workspaceId);
        void vscode.window.showErrorMessage(
          `VSCodeSync: облачный манифест workspace ${workspaceId} повреждён (${reason}). Запустить Repair State?`,
          "Repair State",
        ).then((choice) => {
          if (choice === "Repair State") {
            void vscode.commands.executeCommand("vscodesync.repairState");
          }
        });
      },
      // v0.17 D02 — quota exhaustion banner. Routes to SBOM export so the
      // user sees the heaviest files immediately.
      onQuotaExhausted: (workspaceId: string, posixRel: string, providerLabel: string) => {
        const key = `${workspaceId}:${providerLabel}`;
        // Reuse warnedRemoteDeletedKeys as dedup bucket since we don't have
        // a dedicated one and the lifetime is per-engine which matches.
        if (warnedRemoteDeletedKeys.has(`quota:${key}`)) return;
        warnedRemoteDeletedKeys.add(`quota:${key}`);
        void vscode.window.showWarningMessage(
          `VSCodeSync: облако «${providerLabel}» переполнено. Push «${posixRel}» отклонён.`,
          "Открыть SBOM (тяжёлые файлы)",
          "Сменить провайдер",
        ).then((choice) => {
          if (choice === "Открыть SBOM (тяжёлые файлы)") {
            void vscode.commands.executeCommand("vscodesync.exportSbom");
          } else if (choice === "Сменить провайдер") {
            void vscode.commands.executeCommand("vscodesync.setActiveProvider");
          }
        });
      },
      onMassChange: async (workspaceId: string, report) => {
        const enabled = vscode.workspace
          .getConfiguration("vscodesync")
          .get<boolean>("massChangeGuard", true);
        if (!enabled) return true;
        const { describeMassChange } = await import("../core/massChangeGuard.js");
        const message = describeMassChange(report);
        const choice = await vscode.window.showWarningMessage(
          `VSCodeSync · ${workspaceId}: ${message}`,
          { modal: true },
          "Создать snapshot и продолжить",
          "Продолжить без snapshot",
        );
        if (choice === undefined) return false;
        if (choice === "Создать snapshot и продолжить") {
          try {
            await vscode.commands.executeCommand("vscodesync.createSnapshot");
          } catch {
            /* user-cancelled snapshot is non-fatal — they explicitly opted to proceed */
          }
        }
        return true;
      },
      onRemoteWorkspaceDeleted: (
        workspaceId: string,
        workspaceNote: string,
        rootForRepush: string,
        savedEntry: ActiveWorkspaceEntry,
        savedFiles: TrackedFile[],
      ) => {
        if (warnedRemoteDeletedKeys.has(workspaceId)) {
          return;
        }
        warnedRemoteDeletedKeys.add(workspaceId);
        refs.treeRefresh?.();
        const label = workspaceNote.trim().length > 0 ? `«${workspaceNote}»` : workspaceId;
        void (async () => {
          const choice = await vscode.window.showWarningMessage(
            `VSCodeSync: workspace ${label} удалён с облака другой машиной — отключён локально. Файлы на диске сохранены.`,
            "Залить на облако",
            "Открыть Activity Feed",
          );
          if (choice === "Залить на облако") {
            void refs.repushDeletedWorkspace?.(workspaceId, rootForRepush, savedEntry, savedFiles);
          } else if (choice === "Открыть Activity Feed") {
            void vscode.commands.executeCommand("vscodesync.openActivityFeed");
          }
        })();
      },
    });
  }

  return {
    makeEngine,
    refreshEncryptionKey,
    setRefs(next): void {
      refs = next;
    },
    notifiedConflictKeys,
    profileBuffer,
  };
}
