/**
 * Canonical list of files a support bundle contains.
 *
 * `buildSupportBundleManifest` used to inline this list while the export command
 * wrote only two of the seven names in it. Anyone reading `metadata.json`
 * therefore believed the bundle held an activity log, a health check, sync
 * profile samples, per-workspace digests and 5000 lines of Output — none of
 * which were there. One list, consumed by both sides, plus
 * `supportBundleContents.test.ts` asserting the exporter writes exactly these
 * names, makes that divergence impossible to reintroduce silently.
 */

export type SupportBundleFileName =
  | "metadata.json"
  | "settings.redacted.json"
  | "runtime-state.json"
  | "activity.last7d.json"
  | "health-check.txt"
  | "profile-sync.txt"
  | "manifest-digest.json"
  | "log.txt";

export interface SupportBundleFileSpec {
  readonly name: SupportBundleFileName;
  readonly description: string;
  /** True when the file carries a countable number of records. */
  readonly counted?: boolean;
}

export const SUPPORT_BUNDLE_FILES: readonly SupportBundleFileSpec[] = [
  { name: "metadata.json", description: "Version + provider summary" },
  {
    name: "settings.redacted.json",
    description: "Every declared vscodesync.* setting, secrets redacted",
  },
  {
    name: "runtime-state.json",
    description: "Request queues, held file locks, workspace instance lock — the state that explains a hang",
  },
  { name: "activity.last7d.json", description: "Activity Feed", counted: true },
  { name: "health-check.txt", description: "Latest Health Check output", counted: true },
  { name: "profile-sync.txt", description: "Sync profile samples", counted: true },
  { name: "manifest-digest.json", description: "Per-workspace digests (no paths/hashes)" },
  { name: "log.txt", description: "Tail of the Diagnostics output channel (up to 5000 lines)" },
];
