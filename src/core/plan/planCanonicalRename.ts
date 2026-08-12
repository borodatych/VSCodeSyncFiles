/**
 * Canonical path editing — the planning half (docs/v3/canonicalPaths.md).
 *
 * Three UX entry points (single-node rename, tree drag-and-drop, the mass path
 * editor) all funnel their edits here as an ordered list of requests. The
 * planner composes them into ONE final per-file mapping against the current
 * manifest (nested edits of a folder and its subfolder collapse instead of
 * fighting), validates target paths, detects collisions and flags the edits
 * that change the file's hashing category (text ↔ binary decides line-ending
 * canonicalisation — machines with other CRLF conventions will see a REAL byte
 * divergence, not just a hash refresh). Pure: manifest rows in, plan out — the
 * preview dialog and the engine consume the same object, so what the user
 * confirmed is exactly what runs.
 */
import { isProbablyBinaryPath } from "../../utils/binary.js";
import type { ManifestFile } from "../cloudLayout.js";
import type { CanonicalMove } from "../canonicalRename.js";

export interface CanonicalRenameRequest {
  scope: "file" | "prefix";
  /** Canonical key (file) or canonical dir prefix, as currently visible. */
  from: string;
  to: string;
}

export type CanonicalRenameProblem =
  | { kind: "invalid-path"; path: string }
  | { kind: "missing-source"; request: CanonicalRenameRequest }
  | { kind: "duplicate-target"; to: string; froms: string[] }
  | { kind: "collision"; move: CanonicalMove };

export type CanonicalRenameWarning =
  | { kind: "case-only"; move: CanonicalMove }
  | { kind: "hash-category-change"; move: CanonicalMove; toBinary: boolean }
  | { kind: "tombstone-target"; move: CanonicalMove };

export interface PlannedCanonicalRename {
  /** Final composed per-file moves, sorted by `from`. Empty when nothing changes. */
  moves: CanonicalMove[];
  /** Final composed dir-prefix moves — drive folder-rule and scope remaps. */
  prefixMoves: CanonicalMove[];
  problems: CanonicalRenameProblem[];
  warnings: CanonicalRenameWarning[];
}

/** POSIX-relative, no empty/`.`/`..` segments, no backslashes. */
export function isValidCanonicalPath(p: string): boolean {
  if (p === "" || p.includes("\\")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function planCanonicalRename(
  manifestFiles: readonly Pick<ManifestFile, "path" | "removedAt">[],
  requests: readonly CanonicalRenameRequest[],
): PlannedCanonicalRename {
  const problems: CanonicalRenameProblem[] = [];
  const warnings: CanonicalRenameWarning[] = [];

  const liveKeys: string[] = [];
  const tombstoneKeys = new Set<string>();
  for (const f of manifestFiles) {
    if (f.removedAt) tombstoneKeys.add(f.path);
    else liveKeys.push(f.path);
  }

  // original key → current key, updated as requests apply in order.
  const current = new Map<string, string>(liveKeys.map((k) => [k, k]));
  // origin prefix → final prefix, composed the same way.
  const prefixPairs: { origin: string; final: string }[] = [];
  const originOfPrefix = (prefix: string): string => {
    for (const p of prefixPairs) {
      if (prefix === p.final) return p.origin;
      if (prefix.startsWith(`${p.final}/`)) return `${p.origin}${prefix.slice(p.final.length)}`;
    }
    return prefix;
  };

  for (const req of requests) {
    if (!isValidCanonicalPath(req.from)) {
      problems.push({ kind: "invalid-path", path: req.from });
      continue;
    }
    if (!isValidCanonicalPath(req.to)) {
      problems.push({ kind: "invalid-path", path: req.to });
      continue;
    }
    if (req.from === req.to) {
      continue;
    }
    if (req.scope === "file") {
      let touched = false;
      for (const [origin, cur] of current) {
        if (cur === req.from) {
          current.set(origin, req.to);
          touched = true;
        }
      }
      if (!touched) problems.push({ kind: "missing-source", request: req });
      continue;
    }
    // prefix
    const fromDir = `${req.from}/`;
    let touched = false;
    for (const [origin, cur] of current) {
      if (cur.startsWith(fromDir)) {
        current.set(origin, `${req.to}${cur.slice(req.from.length)}`);
        touched = true;
      }
    }
    if (!touched) {
      problems.push({ kind: "missing-source", request: req });
      continue;
    }
    let composed = false;
    for (const p of prefixPairs) {
      if (p.final === req.from || p.final.startsWith(fromDir)) {
        p.final = `${req.to}${p.final.slice(req.from.length)}`;
        composed = true;
      }
    }
    if (!composed) {
      prefixPairs.push({ origin: originOfPrefix(req.from), final: req.to });
    }
  }

  const moves: CanonicalMove[] = [...current]
    .filter(([origin, cur]) => origin !== cur)
    .map(([origin, cur]) => ({ from: origin, to: cur }))
    .sort((a, b) => a.from.localeCompare(b.from));

  // Collision analysis over the FINAL mapping: duplicate targets, and targets
  // occupied by live keys the batch does not itself move away.
  const byTarget = new Map<string, string[]>();
  for (const m of moves) {
    const froms = byTarget.get(m.to);
    if (froms) froms.push(m.from);
    else byTarget.set(m.to, [m.from]);
  }
  for (const [to, froms] of byTarget) {
    if (froms.length > 1) problems.push({ kind: "duplicate-target", to, froms });
  }
  const movedAway = new Set(moves.map((m) => m.from));
  const liveSet = new Set(liveKeys);
  for (const m of moves) {
    if (liveSet.has(m.to) && !movedAway.has(m.to)) {
      problems.push({ kind: "collision", move: m });
    }
  }

  for (const m of moves) {
    if (m.from.toLowerCase() === m.to.toLowerCase()) {
      warnings.push({ kind: "case-only", move: m });
    }
    const wasBinary = isProbablyBinaryPath(m.from);
    const isBinary = isProbablyBinaryPath(m.to);
    if (wasBinary !== isBinary) {
      warnings.push({ kind: "hash-category-change", move: m, toBinary: isBinary });
    }
    if (tombstoneKeys.has(m.to)) {
      warnings.push({ kind: "tombstone-target", move: m });
    }
  }

  return {
    moves,
    prefixMoves: prefixPairs
      .filter((p) => p.origin !== p.final)
      .map((p) => ({ from: p.origin, to: p.final })),
    problems,
    warnings,
  };
}
