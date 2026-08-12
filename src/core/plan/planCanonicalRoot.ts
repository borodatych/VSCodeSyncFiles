/**
 * "How does this folder lie in the cloud?" — the choice made when a folder is
 * first sent (docs/v2/linkBindings.md).
 *
 * The user's case: at home the tree starts with `src/SEMD272/jscore/…`, at
 * work the same tree starts with `jscore/…`. Sending the local path verbatim
 * would force the work machine to carry a prefix that means nothing there. So
 * the sender picks how much of the leading path is "local dressing" and gets
 * dropped: the remainder becomes the canonical path, and the dropped part
 * turns into this machine's folder rule.
 *
 * Pure: paths in, options out. No I/O, no `vscode`.
 */

export interface CanonicalRootOption {
  /** Local prefix that would be dropped ("" — nothing is dropped). */
  droppedPrefix: string;
  /** Canonical root the cloud would see. */
  canonicalRoot: string;
  /** How the first file would be keyed, as a sample for the picker. */
  sampleCanonicalPath: string;
}

export interface CanonicalRootInput {
  /** Local posix path of the folder being sent, relative to the sync root. */
  localDirRel: string;
  /** One local file path below it — the sample shown next to each option. */
  sampleLocalPath?: string;
}

/**
 * Every way to cut the leading segments off, longest folder first: `as is`,
 * then dropping one segment at a time. `src/SEMD272/jscore` yields
 * `src/SEMD272/jscore` → `SEMD272/jscore` → `jscore`.
 */
export function planCanonicalRootOptions(input: CanonicalRootInput): CanonicalRootOption[] {
  const local = input.localDirRel.replace(/^\/+|\/+$/g, "");
  if (local === "") {
    return [];
  }
  const segs = local.split("/");
  const sample = input.sampleLocalPath?.replace(/^\/+/, "");
  const out: CanonicalRootOption[] = [];
  for (let drop = 0; drop < segs.length; drop++) {
    const droppedPrefix = segs.slice(0, drop).join("/");
    const canonicalRoot = segs.slice(drop).join("/");
    let sampleCanonicalPath = canonicalRoot;
    if (sample?.startsWith(`${local}/`) === true) {
      const tail = sample.slice(local.length + 1);
      sampleCanonicalPath = `${canonicalRoot}/${tail}`;
    }
    out.push({ droppedPrefix, canonicalRoot, sampleCanonicalPath });
  }
  return out;
}

/**
 * Canonical key for one local file under the chosen root, or `undefined` when
 * the file is not below the folder being sent.
 */
export function canonicalKeyUnderRoot(
  localDirRel: string,
  canonicalRoot: string,
  localPath: string,
): string | undefined {
  const local = localDirRel.replace(/^\/+|\/+$/g, "");
  const canon = canonicalRoot.replace(/^\/+|\/+$/g, "");
  if (local === "" || canon === "") {
    return undefined;
  }
  if (localPath === local) {
    return canon;
  }
  const prefix = `${local}/`;
  if (!localPath.startsWith(prefix)) {
    return undefined;
  }
  return `${canon}/${localPath.slice(prefix.length)}`;
}
