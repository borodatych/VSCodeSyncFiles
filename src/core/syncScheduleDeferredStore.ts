import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeTextFileAtomic } from "./writeTextFileAtomic.js";

const FILE_NAME = "schedule-deferred.json";

export type DeferredQueueItem =
  | { kind: "fullSync" }
  | { kind: "push"; root: string; rel: string; workspaceId: string }
  | { kind: "pull"; root: string; rel: string; workspaceId: string };

interface Persisted {
  v: 1;
  items: DeferredQueueItem[];
}

function keyForFileOp(it: Extract<DeferredQueueItem, { kind: "push" | "pull" }>): string {
  return `${it.root.replace(/\\/g, "/").toLowerCase()}|${it.rel}|${it.workspaceId}`;
}

/**
 * Persisted queue for sync operations deferred while automatic sync is outside `syncSchedule` window.
 */
export class SyncScheduleDeferredStore {
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
      const items = rawItems.filter(isDeferredQueueItem);
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

  private mergeEnqueue(prev: DeferredQueueItem[], item: DeferredQueueItem): DeferredQueueItem[] {
    if (item.kind === "fullSync") {
      return [{ kind: "fullSync" }];
    }
    if (prev.some((i) => i.kind === "fullSync")) {
      return [{ kind: "fullSync" }];
    }
    const itemsNoFull = prev.filter((i): i is Exclude<DeferredQueueItem, { kind: "fullSync" }> => i.kind !== "fullSync");
    const kNew = keyForFileOp(item);
    const filtered = itemsNoFull.filter((i) => keyForFileOp(i) !== kNew);
    filtered.push(item);
    return filtered;
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
      await this.writeUnsafe({ v: 1, items: [{ kind: "fullSync" }] });
    });
  }

  async peek(): Promise<DeferredQueueItem[]> {
    const p = await this.readUnsafe();
    return [...p.items];
  }

  async totalPending(): Promise<number> {
    const p = await this.readUnsafe();
    return p.items.length;
  }

  async drainSnapshot(): Promise<DeferredQueueItem[]> {
    let snap: DeferredQueueItem[] = [];
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      snap = [...cur.items];
      await this.writeUnsafe({ v: 1, items: [] });
    });
    return snap;
  }

  /** Put items back at the front (e.g. flush aborted — no provider). */
  async prependItems(items: DeferredQueueItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.serialize(async () => {
      const cur = await this.readUnsafe();
      await this.writeUnsafe({ v: 1, items: [...items, ...cur.items] });
    });
  }
}

function isDeferredQueueItem(x: unknown): x is DeferredQueueItem {
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
  return false;
}
