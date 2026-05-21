/**
 * M5 — GitHub Releases as a (snapshot-only) cloud provider — skeleton.
 *
 * Idea: use a private GitHub repository's Releases for snapshot
 * archives. Each VSCodeSync snapshot publishes a tagged release with
 * the encrypted bundle as a release asset; restore = `gh release
 * download <tag>`. Cheap, versioned, free for private repos.
 *
 * Not suitable for live blob-level sync (release uploads aren't
 * deletable per-asset reliably and the API has rate limits) — so this
 * provider is **snapshot-only**, complementing the main provider.
 *
 * This skeleton declares the shapes and decides whether a release name
 * matches the VSCodeSync convention. The HTTP layer (PAT auth, upload
 * via REST, download) lives in `githubReleasesProvider.ts` — TODO.
 */

export interface GhReleasesProviderConfig {
  /** `owner/repo` slug. */
  repo: string;
  /** PAT with `repo` scope (private repos). Stored via SecretStore. */
  patSecretKey: string;
  /** Tag prefix; default `vscodesync-snapshot-`. */
  tagPrefix?: string;
}

export const DEFAULT_GH_SNAPSHOT_TAG_PREFIX = "vscodesync-snapshot-";

export function buildSnapshotTag(prefix: string, isoTimestamp: string): string {
  // GitHub tags allow only [A-Za-z0-9._/-]+; sanitise the iso.
  const safe = isoTimestamp.replace(/[^A-Za-z0-9._/-]/g, "-");
  return `${prefix}${safe}`;
}

export function isSnapshotTag(tag: string, prefix: string): boolean {
  return tag.startsWith(prefix);
}

/** Sentinel: provider not implemented yet — UI catches and routes to
 *  «GH Releases provider в работе» message. */
export class GhReleasesProviderNotImplementedError extends Error {
  constructor() {
    super("GitHub Releases provider: HTTP layer not implemented yet (skeleton)");
    this.name = "GhReleasesProviderNotImplementedError";
  }
}
