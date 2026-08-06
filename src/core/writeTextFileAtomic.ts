import * as fs from "node:fs/promises";
import * as path from "node:path";

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRenameBlockingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code !== undefined && RETRY_CODES.has(code);
}

async function tryUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Windows (and occasionally AV): replacing an existing file via rename() fails with EPERM
 * while another handle keeps the destination open. Retry with backoff before giving up.
 */
export async function renameReplacingFileWithRetries(fromPath: string, toPath: string): Promise<void> {
  const maxAttempts = 10;
  let delayMs = 20;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.rename(fromPath, toPath);
      return;
    } catch (e) {
      if (!isRenameBlockingError(e) || i === maxAttempts - 1) {
        throw e;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
}

/**
 * Monotonic per-process counter for temp names.
 *
 * The name used to be `<file>.<pid>.<Date.now()>.tmp`, which is *not* unique:
 * two writes from the same process within the same millisecond produced
 * identical paths. With workspaces syncing in parallel that is the normal case,
 * not a corner case — both writers wrote into one temp file and both renamed it
 * over the target, so one config version vanished entirely.
 */
let tmpSequence = 0;

function tmpPathNextTo(filePath: string): string {
  tmpSequence += 1;
  const unique = `${String(process.pid)}.${String(Date.now())}.${String(tmpSequence)}`;
  return `${filePath}.${unique}.tmp`;
}

/**
 * Best-effort atomic UTF-8 write: temp file next to target, rename into place.
 *
 * If rename stays blocked (Windows AV / file watcher holding a handle), we make
 * a second attempt that first deletes the destination and then renames a fresh
 * temp into its place — this preserves the new bytes on disk under a temp name
 * even if the swap fails. As a last resort we fall back to a direct overwrite.
 */
export async function writeTextFileAtomic(filePath: string, body: string): Promise<void> {
  await writeFileAtomic(filePath, body);
}

/**
 * Binary-safe variant of {@link writeTextFileAtomic}: same temp+rename dance
 * and the same EPERM/EACCES/EBUSY retries, but the payload may be a Buffer.
 *
 * User files (pulled blobs, Quick Transfer packages, P2P deliveries) go through
 * this one — they are as likely to be binary as text, and they are exactly the
 * writes that must not leave a half-written file behind on Windows.
 */
export async function writeFileAtomic(filePath: string, body: Buffer | string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tmpPathNextTo(filePath);
  await writeBody(tmp, body);
  try {
    await renameReplacingFileWithRetries(tmp, filePath);
    return;
  } catch (e: unknown) {
    if (!isRenameBlockingError(e)) {
      await tryUnlink(tmp);
      throw e;
    }
  }

  // Rename was blocked — try the unlink-then-rename swap. The new bytes stay
  // on disk under `tmp` for the duration of this fallback path.
  try {
    await fs.unlink(filePath);
    await renameReplacingFileWithRetries(tmp, filePath);
    return;
  } catch (e: unknown) {
    if (!isRenameBlockingError(e)) {
      await tryUnlink(tmp);
      throw e;
    }
  }

  // Last resort: direct overwrite. We still hold `tmp` until the write
  // succeeds so that a crash mid-write leaves a recoverable copy nearby.
  try {
    await writeBody(filePath, body);
  } finally {
    await tryUnlink(tmp);
  }
}

function writeBody(target: string, body: Buffer | string): Promise<void> {
  return typeof body === "string" ? fs.writeFile(target, body, "utf8") : fs.writeFile(target, body);
}
