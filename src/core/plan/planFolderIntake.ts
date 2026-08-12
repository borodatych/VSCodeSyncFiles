/**
 * Folder intake (docs/v2/linkBindings.md): what a cloud folder would look like
 * on this machine before anything is written.
 *
 * The user's case: the cloud carries `php/modules/di_config.php`, this machine
 * wants it under `promed/`. The decision is cheap to make and expensive to
 * undo, so it deserves a preview — "cloud → here" for the first rows plus a
 * count — and an honest answer to "does the structure inside actually match?".
 *
 * Pure: paths in, plan out. No I/O, no `vscode`.
 */

export interface FolderIntakeInput {
  /** Canonical folder prefix in the cloud, no trailing slash. */
  canonicalPrefix: string;
  /** Where it should live on this machine, no trailing slash. */
  localPrefix: string;
  /** Live canonical manifest paths of the workspace. */
  manifestPaths: readonly string[];
  /** Local posix paths that exist on this machine (any subset is fine). */
  localPaths: readonly string[];
  /** Rows this machine already tracks, by local path. */
  trackedLocalPaths?: readonly string[];
  /** How many rows to show in the preview. */
  previewLimit?: number;
}

export interface FolderIntakeRow {
  canonical: string;
  local: string;
  /** A file already sits at the target path — content decides, never a silent overwrite. */
  collides: boolean;
  /** The target path is already tracked by another manifest row. */
  takenByOtherRow: boolean;
}

export interface FolderIntakePlan {
  rows: FolderIntakeRow[];
  /** First `previewLimit` rows, for the confirmation dialog. */
  preview: FolderIntakeRow[];
  total: number;
  /** Rows whose relative tail already exists locally — the "structure matches" signal. */
  matchedCount: number;
  collisions: FolderIntakeRow[];
  /** True when the mapping changes nothing (canonical === local). */
  identity: boolean;
}

export function planFolderIntake(input: FolderIntakeInput): FolderIntakePlan {
  const canon = input.canonicalPrefix.replace(/^\/+|\/+$/g, "");
  const local = input.localPrefix.replace(/^\/+|\/+$/g, "");
  const localSet = new Set(input.localPaths);
  const trackedSet = new Set(input.trackedLocalPaths ?? []);
  const prefix = `${canon}/`;

  const rows: FolderIntakeRow[] = [];
  for (const p of input.manifestPaths) {
    if (!p.startsWith(prefix)) continue;
    const tail = p.slice(prefix.length);
    const target = local === "" ? tail : `${local}/${tail}`;
    rows.push({
      canonical: p,
      local: target,
      collides: localSet.has(target),
      takenByOtherRow: trackedSet.has(target),
    });
  }
  rows.sort((a, b) => a.canonical.localeCompare(b.canonical));
  const limit = input.previewLimit ?? 10;
  return {
    rows,
    preview: rows.slice(0, limit),
    total: rows.length,
    matchedCount: rows.filter((r) => r.collides).length,
    collisions: rows.filter((r) => r.collides || r.takenByOtherRow),
    identity: canon === local,
  };
}

/** Human-readable «cloud → here» block for the confirmation modal. */
export function describeFolderIntake(plan: FolderIntakePlan): string {
  if (plan.total === 0) {
    return "В этой облачной папке нет файлов.";
  }
  const lines = plan.preview.map((r) => `  ${r.canonical}  →  ${r.local}`);
  const rest = plan.total - plan.preview.length;
  if (rest > 0) {
    lines.push(`  …и ещё ${String(rest)}`);
  }
  const head = `Файлов: ${String(plan.total)}. Структура внутри совпала: ${String(plan.matchedCount)}.`;
  return [head, "", ...lines].join("\n");
}
