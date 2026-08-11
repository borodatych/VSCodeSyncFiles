/**
 * v2.3.4 — pure loop of the `hashBlake3` backfill (extracted verbatim from
 * `syncEngine.applyHashBlake3Backfill`; engine line-ceiling offset for Link
 * Bindings). Decides per task whether to fill the BLAKE3 column, mutating the
 * caller-owned `updated.files` copy. File bytes come through the injected
 * reader so the loop stays testable without a disk.
 */
import type { MetaJson } from "../cloudLayout.js";
import type { DualHash } from "../hashProviders.js";

export interface Blake3BackfillReport {
  applied: number;
  skippedMissing: number;
  skippedDrift: number;
  skippedAlreadyDone: number;
}

export async function runBlake3BackfillTasks(
  updated: MetaJson,
  tasks: { relPath: string; existingSha256: string }[],
  deps: {
    /** Bytes of the tracked file at the machine's own placement; null when unreadable. */
    readTrackedBytes: (canonicalRel: string) => Promise<Buffer | null>;
    /** `hashCanonicalBufferDual` keyed by the canonical rel. */
    dualHash: (buf: Buffer, canonicalRel: string) => DualHash;
  },
): Promise<Blake3BackfillReport> {
  const report: Blake3BackfillReport = { applied: 0, skippedMissing: 0, skippedDrift: 0, skippedAlreadyDone: 0 };
  for (const task of tasks) {
    const row = updated.files[task.relPath];
    if (!row) {
      report.skippedMissing += 1;
      continue;
    }
    if (typeof row.hashBlake3 === "string" && /^[0-9a-f]{64}$/.test(row.hashBlake3)) {
      report.skippedAlreadyDone += 1;
      continue;
    }
    const buf = await deps.readTrackedBytes(task.relPath);
    if (buf === null) {
      report.skippedMissing += 1;
      continue;
    }
    const dual = deps.dualHash(buf, task.relPath);
    // Drift guard — if the local file's sha256 differs from the meta's
    // current sha256, refuse to backfill: the local copy is out of sync
    // with the cloud meta and a regular pushFile is the right path.
    if (dual.sha256 !== row.hash) {
      report.skippedDrift += 1;
      continue;
    }
    updated.files[task.relPath] = { ...row, hashBlake3: dual.blake3 };
    report.applied += 1;
  }
  return report;
}
