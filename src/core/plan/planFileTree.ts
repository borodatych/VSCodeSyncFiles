/**
 * Folder tree for the workspaces panel (docs/v2/linkBindings.md, folder UX).
 *
 * A workspace of 60+ files rendered flat is unreadable: the structure the user
 * thinks in — `jscore/Forms4/Common/…` — exists only in their head and in the
 * editor tab. This planner turns the tracked rows into the folder hierarchy
 * they already know, so folder-level actions (bind, pull, exclude) have
 * something to hang on.
 *
 * Grouping is by LOCAL placement: that is where the files are on this disk and
 * what the user navigates. The canonical prefix rides along on the node so the
 * UI can show the `⇄ canon` badge once per folder instead of once per file.
 *
 * Chains of single-child folders collapse into one node (`a/b/c`), the way
 * VS Code's own explorer does — otherwise `src/SEMD272/jscore/Forms4/Common`
 * costs five clicks to reach one file.
 *
 * Pure: rows in, nodes out. No I/O, no `vscode`.
 */

export interface FileTreeInputRow {
  localPath: string;
  /** Canonical manifest key when bound elsewhere (Link Bindings). */
  manifestPath?: string;
  syncStatus?: string;
  editingBy?: string;
  editingByName?: string;
}

export interface FileTreeFileNode {
  kind: "file";
  /** Full local posix path — the key every command already speaks. */
  localPath: string;
  /** Last segment, shown as the label. */
  name: string;
  manifestPath?: string;
  syncStatus?: string;
  editingBy?: string;
  editingByName?: string;
}

export interface FileTreeFolderNode {
  kind: "folder";
  /** Full local posix prefix of this folder, no trailing slash. */
  localPrefix: string;
  /** Label: the segment(s) this node covers (collapsed chains keep `a/b`). */
  name: string;
  /** Number of tracked files anywhere below. */
  fileCount: number;
  /**
   * Canonical prefix this folder maps to, when every file below agrees on one
   * and it differs from the local prefix. Undefined when unbound or mixed —
   * a single badge must never claim a mapping that only holds for part of the
   * subtree.
   */
  canonicalPrefix?: string;
  /** Files below that are tracked but absent on disk. */
  missingCount: number;
}

export type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

/** Canonical prefix implied by one row, if its mapping is a pure prefix swap. */
function canonicalPrefixFor(row: FileTreeInputRow, localPrefix: string): string | undefined {
  const canon = row.manifestPath;
  if (canon === undefined || canon === row.localPath) {
    return undefined;
  }
  const tail = row.localPath.slice(localPrefix.length); // includes leading "/"
  return canon.endsWith(tail) ? canon.slice(0, canon.length - tail.length) : undefined;
}

/**
 * Children of `parentPrefix` ("" = workspace root), folders first, each side
 * sorted case-insensitively — the order the panel keeps between refreshes.
 */
export function planFileTreeChildren(
  rows: readonly FileTreeInputRow[],
  parentPrefix: string,
): FileTreeNode[] {
  const prefix = parentPrefix === "" ? "" : `${parentPrefix}/`;
  const under = rows.filter((r) => r.localPath.startsWith(prefix));

  const files: FileTreeFileNode[] = [];
  /** Immediate child folder segment → rows below it. */
  const folders = new Map<string, FileTreeInputRow[]>();

  for (const row of under) {
    const rest = row.localPath.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({
        kind: "file",
        localPath: row.localPath,
        name: rest,
        ...(row.manifestPath === undefined ? {} : { manifestPath: row.manifestPath }),
        ...(row.syncStatus === undefined ? {} : { syncStatus: row.syncStatus }),
        ...(row.editingBy === undefined ? {} : { editingBy: row.editingBy }),
        ...(row.editingByName === undefined ? {} : { editingByName: row.editingByName }),
      });
      continue;
    }
    const seg = rest.slice(0, slash);
    const bucket = folders.get(seg);
    if (bucket) bucket.push(row);
    else folders.set(seg, [row]);
  }

  const folderNodes: FileTreeFolderNode[] = [];
  for (const [seg, bucket] of folders) {
    let localPrefix = `${prefix}${seg}`;
    let label = seg;
    // Collapse single-child chains: while everything below sits in exactly one
    // subfolder and no file lives at this level, fold it into the label.
    for (;;) {
      const inner = new Set<string>();
      let hasFileHere = false;
      for (const r of bucket) {
        const rest = r.localPath.slice(localPrefix.length + 1);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          hasFileHere = true;
          break;
        }
        inner.add(rest.slice(0, slash));
        if (inner.size > 1) break;
      }
      if (hasFileHere || inner.size !== 1) break;
      const only = [...inner][0];
      localPrefix = `${localPrefix}/${only}`;
      label = `${label}/${only}`;
    }

    const canonSet = new Set<string | undefined>();
    let missingCount = 0;
    for (const r of bucket) {
      canonSet.add(canonicalPrefixFor(r, localPrefix));
      if (r.syncStatus === "missing_local") missingCount += 1;
    }
    const onlyCanon = canonSet.size === 1 ? [...canonSet][0] : undefined;
    folderNodes.push({
      kind: "folder",
      localPrefix,
      name: label,
      fileCount: bucket.length,
      missingCount,
      ...(onlyCanon !== undefined && onlyCanon !== localPrefix ? { canonicalPrefix: onlyCanon } : {}),
    });
  }

  const byName = (a: { name: string }, b: { name: string }): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  folderNodes.sort(byName);
  files.sort(byName);
  return [...folderNodes, ...files];
}
