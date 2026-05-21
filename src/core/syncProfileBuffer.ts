/**
 * v0.7 — bounded ring buffer for `SyncProfileSample`s emitted by
 * `SyncEngine.onSyncProfileSample`. Pure: no `vscode`, no disk.
 *
 * The host owns one buffer per session. The engine calls `.push(sample)`;
 * the `VSCodeSync: Профиль синка` command reads `.snapshot()` to build a
 * report. When `diagnostics.profileSync` is off, nothing is pushed and the
 * buffer remains empty (zero overhead).
 */

import type { SyncProfileSample } from "./syncEngine.js";

export interface SyncProfileBuffer {
  push(sample: SyncProfileSample): void;
  snapshot(): SyncProfileSample[];
  clear(): void;
  /** Number of samples currently held. */
  size(): number;
}

export interface SyncProfileBufferOptions {
  /** Max samples to retain. Older samples are dropped FIFO. */
  capacity?: number;
}

export function createSyncProfileBuffer(opts: SyncProfileBufferOptions = {}): SyncProfileBuffer {
  const cap = Math.max(10, opts.capacity ?? 500);
  const ring: SyncProfileSample[] = [];
  return {
    push(s: SyncProfileSample): void {
      ring.push(s);
      if (ring.length > cap) {
        ring.shift();
      }
    },
    snapshot(): SyncProfileSample[] {
      return ring.slice();
    },
    clear(): void {
      ring.length = 0;
    },
    size(): number {
      return ring.length;
    },
  };
}

/** Aggregation shape for the report. */
export interface SyncProfileTopFile {
  posixRel: string;
  workspaceId: string;
  kind: "push" | "pull";
  pretty: string;
}

interface ProfileAcc {
  totalMs: number;
  networkMs: number;
  hashMs: number;
  verifyMs: number;
  bytes: number;
  kind: "push" | "pull";
  samples: number;
}

/** Build a human-readable "top N slowest files" snapshot. */
export function buildSyncProfileReport(
  samples: readonly SyncProfileSample[],
  topN = 10,
): string[] {
  if (samples.length === 0) {
    return ["VSCodeSync · Profile: пока нет образцов. Включите vscodesync.diagnostics.profileSync и выполните Push/Pull/Sync."];
  }
  // Group by (workspaceId, posixRel) and average the wall clock — useful
  // since the same file can be measured several times during one session.
  // Separator U+0001 is illegal in POSIX paths AND in our workspaceId regex,
  // so it's safe vs `#` which legitimately appears in filenames.
  const SEP = "";
  const byKey = new Map<string, ProfileAcc>();
  for (const s of samples) {
    const key = `${s.workspaceId}${SEP}${s.posixRel}${SEP}${s.kind}`;
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, {
        totalMs: s.totalMs,
        networkMs: s.networkMs,
        hashMs: s.hashMs,
        verifyMs: s.verifyMs,
        bytes: s.bytes,
        kind: s.kind,
        samples: 1,
      });
    } else {
      cur.totalMs += s.totalMs;
      cur.networkMs += s.networkMs;
      cur.hashMs += s.hashMs;
      cur.verifyMs += s.verifyMs;
      cur.bytes += s.bytes;
      cur.samples += 1;
    }
  }
  const rows = [...byKey.entries()]
    .map(([key, acc]) => {
      const parts = key.split(SEP);
      const workspaceId = parts[0] ?? "";
      const posixRel = parts[1] ?? "";
      const kind: "push" | "pull" = acc.kind;
      const avg = acc.totalMs / acc.samples;
      return {
        posixRel,
        workspaceId,
        kind,
        avgMs: avg,
        netMs: acc.networkMs / acc.samples,
        hashMs: acc.hashMs / acc.samples,
        verifyMs: acc.verifyMs / acc.samples,
        avgBytes: acc.bytes / acc.samples,
        samples: acc.samples,
      };
    })
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, topN);

  const lines: string[] = [];
  lines.push(`VSCodeSync · Профиль синка — топ ${String(rows.length)} (всего образцов: ${String(samples.length)})`);
  lines.push("");
  lines.push("  avgMs  net   hash  verify  bytes   n×   kind  file");
  for (const r of rows) {
    const bytes = r.avgBytes > 1024 * 1024 ? `${(r.avgBytes / 1024 / 1024).toFixed(1)}M` : `${(r.avgBytes / 1024).toFixed(1)}K`;
    lines.push(
      [
        r.avgMs.toFixed(0).padStart(6),
        r.netMs.toFixed(0).padStart(5),
        r.hashMs.toFixed(0).padStart(5),
        r.verifyMs.toFixed(0).padStart(6),
        bytes.padStart(7),
        String(r.samples).padStart(3) + "×",
        r.kind.padStart(5),
        `  ${r.posixRel}`,
      ].join("  "),
    );
  }
  return lines;
}
