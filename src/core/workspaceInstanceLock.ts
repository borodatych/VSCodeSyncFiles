import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  setSecondaryWorkspaceInstanceReadOnly,
} from "./syncWorkspaceInstanceReadOnly.js";
import { renameReplacingFileWithRetries } from "./writeTextFileAtomic.js";

const execFileAsync = promisify(execFile);

const ACQUIRE_RETRIES = 8;

export interface WorkspaceLockBody {
  pid: number;
  nonce: string;
  lockedAt: string;
}

export function hashWorkspaceRoots(roots: string[]): string {
  const norm = [...roots]
    .map((r) => path.resolve(r).replace(/\\/g, "/").toLowerCase())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return createHash("sha256").update(norm.join("\0"), "utf8").digest("hex");
}

function lockFilePath(storageDir: string, workspaceHash: string): string {
  return path.join(storageDir, `${workspaceHash}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Windows PID reuse: new process may get a dead PID; CreationDate will be after `lockedAt`. */
async function windowsProcessCreationTimeUtcMs(pid: number): Promise<number | null> {
  if (process.platform !== "win32") {
    return null;
  }
  try {
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}"; ` +
      `if ($null -eq $p) { exit 2 }; $p.CreationDate.ToUniversalTime().ToString('o')`;
    const { stdout, stderr } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { windowsHide: true, timeout: 8000, maxBuffer: 256 },
    );
    if (stderr && !stdout) {
      return null;
    }
    const t = Date.parse(stdout.trim());
    return Number.isNaN(t) ? null : t;
  } catch (e) {
    const err = e as { code?: number };
    if (err.code === 2) {
      return null;
    }
    return null;
  }
}

async function isForeignLockStillValid(body: WorkspaceLockBody): Promise<boolean> {
  if (!isProcessAlive(body.pid)) {
    return false;
  }
  const lockedMs = Date.parse(body.lockedAt);
  if (Number.isNaN(lockedMs)) {
    return false;
  }
  if (process.platform === "win32") {
    const createdMs = await windowsProcessCreationTimeUtcMs(body.pid);
    if (createdMs === null) {
      /* Conservative: treat as held if we cannot disprove reuse. */
      return true;
    }
    return createdMs <= lockedMs + 3000;
  }
  return true;
}

async function tryUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

async function readLock(p: string): Promise<WorkspaceLockBody | undefined> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const data = JSON.parse(raw) as Partial<WorkspaceLockBody>;
    if (
      typeof data.pid !== "number" ||
      typeof data.nonce !== "string" ||
      typeof data.lockedAt !== "string"
    ) {
      return undefined;
    }
    return { pid: data.pid, nonce: data.nonce, lockedAt: data.lockedAt };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }
}

let lockChain: Promise<void> = Promise.resolve();
let ownerLockPath: string | null = null;
let ownerNonce: string | null = null;
let lastRootsKey: string | null = null;

export async function disposeWorkspaceInstanceLock(): Promise<void> {
  await releaseOurLockFile();
  lastRootsKey = null;
  setSecondaryWorkspaceInstanceReadOnly(false);
}

async function releaseOurLockFile(): Promise<void> {
  if (!ownerLockPath || !ownerNonce) {
    ownerLockPath = null;
    ownerNonce = null;
    return;
  }
  const p = ownerLockPath;
  const n = ownerNonce;
  ownerLockPath = null;
  ownerNonce = null;
  try {
    const body = await readLock(p);
    if (body?.nonce === n && body.pid === process.pid) {
      await tryUnlink(p);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Serialized refresh: call when workspace folders change or on startup.
 * `roots`: absolute fs paths of `WorkspaceFolder`s (empty = close project, release lock).
 */
export function scheduleWorkspaceInstanceLockRefresh(
  storageDir: string,
  roots: string[],
  onApplied: () => void,
): void {
  lockChain = lockChain
    .then(async () => {
      await applyWorkspaceInstanceLock(storageDir, roots);
    })
    .then(
      () => {
        onApplied();
      },
      () => {
        onApplied();
      },
    );
}

async function applyWorkspaceInstanceLock(storageDir: string, roots: string[]): Promise<void> {
  const nextKey = roots.length === 0 ? "" : hashWorkspaceRoots(roots);

  if (nextKey !== "" && nextKey === lastRootsKey && ownerLockPath && ownerNonce) {
    const body = await readLock(ownerLockPath);
    if (body?.nonce === ownerNonce && body.pid === process.pid) {
      return;
    }
  }

  await releaseOurLockFile();
  lastRootsKey = nextKey;

  if (!nextKey) {
    setSecondaryWorkspaceInstanceReadOnly(false);
    return;
  }

  await fs.mkdir(storageDir, { recursive: true });
  const lockPath = lockFilePath(storageDir, nextKey);
  const nonce = randomUUID();
  const body: WorkspaceLockBody = {
    pid: process.pid,
    nonce,
    lockedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < ACQUIRE_RETRIES; attempt += 1) {
    const existing = await readLock(lockPath);
    if (existing !== undefined) {
      const held = await isForeignLockStillValid(existing);
      if (held) {
        setSecondaryWorkspaceInstanceReadOnly(true);
        return;
      }
      await tryUnlink(lockPath);
    }

    const tmp = path.join(
      storageDir,
      `.lock-tmp-${nextKey}-${String(process.pid)}-${String(Date.now())}.tmp`,
    );
    try {
      await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      await renameReplacingFileWithRetries(tmp, lockPath);
      ownerLockPath = lockPath;
      ownerNonce = nonce;
      setSecondaryWorkspaceInstanceReadOnly(false);
      return;
    } catch {
      await tryUnlink(tmp);
      /* Contention or foreign recreated lock; retry loop. */
    }
  }

  setSecondaryWorkspaceInstanceReadOnly(true);
}

/**
 * Returns the current lock holder without modifying any lock file.
 * Returns null if no lock exists or the lock belongs to the current process.
 */
export async function peekWorkspaceInstanceLockHolder(
  storageDir: string,
  roots: string[],
): Promise<WorkspaceLockBody | null> {
  if (roots.length === 0) {
    return null;
  }
  const hash = hashWorkspaceRoots(roots);
  const body = await readLock(lockFilePath(storageDir, hash));
  if (!body || body.pid === process.pid) {
    return null;
  }
  return body;
}

/**
 * Forcibly acquires the lock for the current process, evicting whoever held it.
 * Returns the evicted lock body (so the caller can show the previous PID to the user),
 * or null if no foreign lock was present.
 */
export async function forceAcquireWorkspaceInstanceLock(
  storageDir: string,
  roots: string[],
): Promise<WorkspaceLockBody | null> {
  if (roots.length === 0) {
    return null;
  }
  const hash = hashWorkspaceRoots(roots);
  const lockPath = lockFilePath(storageDir, hash);

  const evicted = await readLock(lockPath);
  await tryUnlink(lockPath);

  const nonce = randomUUID();
  const body: WorkspaceLockBody = {
    pid: process.pid,
    nonce,
    lockedAt: new Date().toISOString(),
  };
  await fs.mkdir(storageDir, { recursive: true });
  const tmp = path.join(
    storageDir,
    `.lock-tmp-${hash}-${String(process.pid)}-${String(Date.now())}.tmp`,
  );
  await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await renameReplacingFileWithRetries(tmp, lockPath);

  ownerLockPath = lockPath;
  ownerNonce = nonce;
  lastRootsKey = hash;
  setSecondaryWorkspaceInstanceReadOnly(false);

  return evicted ?? null;
}

/**
 * Human-readable lock state for Health Check (read-only; does not mutate lock files).
 */
export async function describeWorkspaceInstanceLockForHealth(
  storageDir: string,
  roots: string[],
): Promise<string> {
  if (roots.length === 0) {
    return "Lock-файл: нет открытой папки workspace";
  }
  const nextKey = hashWorkspaceRoots(roots);
  const p = lockFilePath(storageDir, nextKey);
  const body = await readLock(p);
  if (!body) {
    return "Lock-файл: нет (нет параллельных окон VSCode для этого набора корней)";
  }
  const valid = await isForeignLockStillValid(body);
  if (body.pid === process.pid && valid) {
    return `Lock-файл: удерживается этим окном (pid ${String(body.pid)})`;
  }
  if (valid) {
    return `Lock-файл: другое окно VSCode удерживает lock (pid ${String(body.pid)}) — это окно в режиме read-only для push`;
  }
  return `Lock-файл: найден, но процесс не активен (pid ${String(body.pid)}) — возможно зависший lock; перезапуск VSCode или удаление файла lock обычно безопасны после проверки`;
}
