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

function tmpPathNextTo(filePath: string): string {
  return `${filePath}.${String(process.pid)}.${String(Date.now())}.tmp`;
}

/**
 * Best-effort atomic UTF-8 write: temp file next to target, rename into place.
 * Falls back to direct write if rename stays blocked (same bytes as temp).
 */
export async function writeTextFileAtomic(filePath: string, body: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tmpPathNextTo(filePath);
  await fs.writeFile(tmp, body, "utf8");
  try {
    await renameReplacingFileWithRetries(tmp, filePath);
  } catch (e) {
    await tryUnlink(tmp);
    if (isRenameBlockingError(e)) {
      await fs.writeFile(filePath, body, "utf8");
      return;
    }
    throw e;
  }
}
