/**
 * Что делать после подключения облачного воркспейса, когда на диске уже лежат файлы
 *
 * Полный проход синхронизации здесь недопустим: принятая строка с отличающимися байтами
 * Выглядела бы локальной правкой, и проход отправил бы её в облако поверх чужой версии
 * Поэтому — только сверка статусов, докачка отсутствующего и решение пользователя
 */
import { warnLog } from "../utils/log.js";
import type { ActiveWorkspaceEntry, WorkspaceConfig } from "./types.js";

export type AttachDivergenceChoice = "take_cloud" | "compare" | "push_local" | "none";

export interface AttachDivergenceSummary {
  workspaceId: string;
  count: number;
  /** Несколько путей для текста окна — весь список показывает панель «Расхождения» */
  samplePaths: string[];
}

export type AttachDivergencePrompt = (summary: AttachDivergenceSummary) => Promise<AttachDivergenceChoice>;

/** Сколько путей уходит в окно вопроса: больше — текст окна перестаёт читаться */
const SAMPLE_PATHS_LIMIT = 5;

/** Статусы, при которых файл на диске и в облаке расходятся */
const DIVERGED_STATUSES: ReadonlySet<string> = new Set(["cloud_newer", "conflict", "pending_push"]);

/** Узкий срез движка: только публичные операции, которые проходят проверку политики изменений */
export interface AttachSettlePort {
  checkWorkspaceStatus(workspaceId: string): Promise<void>;
  pullFile(cfg: WorkspaceConfig, workspaceId: string, posixRel: string, entry?: ActiveWorkspaceEntry): Promise<unknown>;
  pushFile(
    cfg: WorkspaceConfig,
    workspaceId: string,
    posixRel: string,
    entry?: ActiveWorkspaceEntry,
    activityHint?: { userForce?: boolean },
  ): Promise<void>;
  resolveConflictTakeTheirs(workspaceId: string, posixRel: string): Promise<void>;
}

export interface AttachSettleIo {
  loadCfg: () => Promise<WorkspaceConfig>;
  saveCfg: (cfg: WorkspaceConfig) => Promise<void>;
}

/**
 * Сверяет статусы после приёма строк, докачивает отсутствующее и спрашивает про расхождения
 * Возвращает выбор пользователя, `none` — когда расхождений нет или спросить некого
 */
export async function settleAttachDivergence(
  engine: AttachSettlePort,
  io: AttachSettleIo,
  workspaceId: string,
  ask: AttachDivergencePrompt | undefined,
): Promise<AttachDivergenceChoice> {
  await engine.checkWorkspaceStatus(workspaceId);

  // Отсутствующий на диске файл скачивается сразу: перезаписывать нечего
  const missing = await rowsWithStatus(io, workspaceId, (s) => s === "missing_local");
  await forEachRow(io, workspaceId, missing, (cfg, rel, entry) => engine.pullFile(cfg, workspaceId, rel, entry));

  const diverged = await rowsWithStatus(io, workspaceId, (s) => DIVERGED_STATUSES.has(s));
  if (diverged.length === 0 || ask === undefined) {
    return "none";
  }
  const choice = await ask({
    workspaceId,
    count: diverged.length,
    samplePaths: diverged.slice(0, SAMPLE_PATHS_LIMIT).map((r) => r.localPath),
  });
  if (choice === "take_cloud") {
    // Локальная копия перед перезаписью уходит в локальный бэкап внутри pullFile
    const conflicts = diverged.filter((r) => r.status === "conflict");
    const plain = diverged.filter((r) => r.status !== "conflict");
    await forEachRow(io, workspaceId, plain, (cfg, rel, entry) => engine.pullFile(cfg, workspaceId, rel, entry));
    // Конфликт снимается своим путём: pullFile конфликтный файл не трогает
    // Конфиг этот путь читает и пишет сам, поэтому здесь он не сохраняется
    for (const row of conflicts) {
      await engine.resolveConflictTakeTheirs(workspaceId, row.localPath).catch((e: unknown) => {
        warnLog("attachDivergence", `${row.localPath}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  } else if (choice === "push_local") {
    // Облачная версия перед загрузкой уходит в историю снимком внутри pushFile
    await forEachRow(io, workspaceId, diverged, (cfg, rel, entry) =>
      engine.pushFile(cfg, workspaceId, rel, entry, { userForce: true }),
    );
  }
  return choice;
}

interface RowRef {
  localPath: string;
  status: string;
}

async function rowsWithStatus(
  io: AttachSettleIo,
  workspaceId: string,
  match: (status: string) => boolean,
): Promise<RowRef[]> {
  const cfg = await io.loadCfg();
  return cfg.files
    .filter((f) => f.workspaceId === workspaceId && f.syncStatus !== undefined && match(f.syncStatus))
    .map((f) => ({ localPath: f.localPath, status: f.syncStatus ?? "" }));
}

/**
 * Выполняет операцию по каждому файлу на свежем конфиге
 * Сбой одного файла не обрывает остальные: подключение уже состоялось, и полупройденный список хуже
 */
async function forEachRow(
  io: AttachSettleIo,
  workspaceId: string,
  rows: readonly RowRef[],
  op: (cfg: WorkspaceConfig, rel: string, entry: ActiveWorkspaceEntry) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) {
    // Конфиг перечитывается на каждый файл: операция меняет его, и старая копия затёрла бы прошлый статус
    const cfg = await io.loadCfg();
    const entry = cfg.activeWorkspaces.find((w) => w.workspaceId === workspaceId);
    if (!entry) return;
    try {
      await op(cfg, row.localPath, entry);
      await io.saveCfg(cfg);
    } catch (e) {
      warnLog("attachDivergence", `${row.localPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
