import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";

const FILE_NAME = "queue.json";

export type OfflineQuickTransferQueueItem = {
  kind: "quickTransferSend";
  queuedAtIso: string;
  ttlDays: number;
  absolutePath: string;
  projectRelativePosix: string;
  targetMachineId?: string;
  maxFileSizeBytes?: number;
};

export type OfflineQueueItem =
  | { kind: "fullSync" }
  | { kind: "push"; root: string; rel: string; workspaceId: string }
  | { kind: "pull"; root: string; rel: string; workspaceId: string }
  | OfflineQuickTransferQueueItem;

interface Persisted {
  v: 1;
  items: OfflineQueueItem[];
}

function keyForFileOp(it: Extract<OfflineQueueItem, { kind: "push" | "pull" }>): string {
  return `${it.root.replace(/\\/g, "/").toLowerCase()}|${it.rel}|${it.workspaceId}`;
}

function keyForQuickTransferPath(absolutePath: string): string {
  return path.normalize(absolutePath).replace(/\\/g, "/").toLowerCase();
}

function quickTransferOnly(items: OfflineQueueItem[]): OfflineQuickTransferQueueItem[] {
  return items.filter((i): i is OfflineQuickTransferQueueItem => i.kind === "quickTransferSend");
}

function mergeQtList(prev: OfflineQuickTransferQueueItem[], item: OfflineQuickTransferQueueItem): OfflineQuickTransferQueueItem[] {
  const k = keyForQuickTransferPath(item.absolutePath);
  const filtered = prev.filter((i) => keyForQuickTransferPath(i.absolutePath) !== k);
  filtered.push(item);
  return filtered;
}

/**
 * Persisted queue when automatic sync hits transport errors (~/.vscode/vscodeSync/queue.json).
 */
export class SyncOfflineQueueStore {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, FILE_NAME);
  }

  getFilePath(): string {
    return this.filePath;
  }

  private serialize(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn).then(() => undefined);
    this.chain = next;
    return next;
  }

  private async readUnsafe(): Promise<Persisted> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { v?: unknown }).v !== 1 ||
        !Array.isArray((data as { items?: unknown }).items)
      ) {
        return { v: 1, items: [] };
      }
      const rawItems = (data as { items: unknown[] }).items;
      const items = rawItems.filter(isOfflineQueueItem);
      return { v: 1, items };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { v: 1, items: [] };
      }
      return { v: 1, items: [] };
    }
  }

  private async writeUnsafe(body: Persisted): Promise<void> {
    await writeTextFileAtomic(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }

  private mergeEnqueue(prev: OfflineQueueItem[], item: OfflineQueueItem): OfflineQueueItem[] {
    const qtPrev = quickTransferOnly(prev);

    if (item.kind === "fullSync") {
      return [{ kind: "fullSync" }, ...qtPrev];
    }

    const prevHasFull = prev.some((i) => i.kind === "fullSync");
    if (prevHasFull) {
      if (item.kind === "quickTransferSend") {
        return [{ kind: "fullSync" }, ...mergeQtList(qtPrev, item)];
      }
      return [{ kind: "fullSync" }, ...qtPrev];
    }

    const rest = prev.filter((i) => i.kind !== "fullSync");
    const fileOps = rest.filter((i): i is Extract<OfflineQueueItem, { kind: "push" | "pull" }> => i.kind === "push" || i.kind === "pull");
    const qtRest = quickTransferOnly(rest);

    if (item.kind === "quickTransferSend") {
      return [...fileOps, ...mergeQtList(qtRest, item)];
    }

    const kNew = keyForFileOp(item);
    const filtered = fileOps.filter((i) => keyForFileOp(i) !== kNew);
    filtered.push(item);
    return [...filtered, ...qtRest];
  }

  async enqueuePush(root: string, rel: string, workspaceId: string): Promise<void> {
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      const next = this.mergeEnqueue(cur.items, { kind: "push", root, rel, workspaceId });
      await this.writeUnsafe({ v: 1, items: next });
    });
  }

  async enqueuePull(root: string, rel: string, workspaceId: string): Promise<void> {
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      const next = this.mergeEnqueue(cur.items, { kind: "pull", root, rel, workspaceId });
      await this.writeUnsafe({ v: 1, items: next });
    });
  }

  async enqueueFullSync(): Promise<void> {
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      const qt = quickTransferOnly(cur.items);
      await this.writeUnsafe({ v: 1, items: [{ kind: "fullSync" }, ...qt] });
    });
  }

  async enqueueQuickTransferSend(entry: Omit<OfflineQuickTransferQueueItem, "kind">): Promise<void> {
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      const next = this.mergeEnqueue(cur.items, { kind: "quickTransferSend", ...entry });
      await this.writeUnsafe({ v: 1, items: next });
    });
  }

  async totalPending(): Promise<number> {
    const p = await this.readUnsafe();
    return p.items.length;
  }

  async drainSnapshot(): Promise<OfflineQueueItem[]> {
    let snap: OfflineQueueItem[] = [];
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      snap = [...cur.items];
      await this.writeUnsafe({ v: 1, items: [] });
    });
    return snap;
  }

  async prependItems(items: OfflineQueueItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      await this.writeUnsafe({ v: 1, items: [...items, ...cur.items] });
    });
  }
}

function isOfflineQueueItem(x: unknown): x is OfflineQueueItem {
  if (!x || typeof x !== "object") {
    return false;
  }
  const k = (x as { kind?: unknown }).kind;
  if (k === "fullSync") {
    return true;
  }
  if (k === "push" || k === "pull") {
    const o = x as { root?: unknown; rel?: unknown; workspaceId?: unknown };
    return typeof o.root === "string" && typeof o.rel === "string" && typeof o.workspaceId === "string";
  }
  if (k === "quickTransferSend") {
    const o = x as {
      queuedAtIso?: unknown;
      ttlDays?: unknown;
      absolutePath?: unknown;
      projectRelativePosix?: unknown;
      targetMachineId?: unknown;
      maxFileSizeBytes?: unknown;
    };
    if (
      typeof o.queuedAtIso !== "string" ||
      typeof o.ttlDays !== "number" ||
      !Number.isFinite(o.ttlDays) ||
      typeof o.absolutePath !== "string" ||
      typeof o.projectRelativePosix !== "string"
    ) {
      return false;
    }
    if (o.targetMachineId !== undefined && typeof o.targetMachineId !== "string") {
      return false;
    }
    if (o.maxFileSizeBytes !== undefined && (typeof o.maxFileSizeBytes !== "number" || !Number.isFinite(o.maxFileSizeBytes))) {
      return false;
    }
    return true;
  }
  return false;
}
