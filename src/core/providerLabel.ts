/**
 * Display name of a cloud provider — one table, not three.
 *
 * The same switch lived in `statusBar.ts` and `healthCheckReport.ts` (and a
 * third copy was about to be written for the connection check). Duplicated
 * label tables drift silently: the status bar and the report would eventually
 * disagree about what the user's own cloud is called.
 */
import type { ProviderType } from "./types.js";

/** Placeholder shown when no provider is selected. */
export const NO_PROVIDER_LABEL = "—";

export function providerDisplayName(type: ProviderType | null | undefined): string {
  switch (type) {
    case "onedrive":
      return "OneDrive";
    case "gdrive":
      return "Google Drive";
    case "yandex":
      return "Yandex Disk";
    case "dropbox":
      return "Dropbox";
    default:
      return NO_PROVIDER_LABEL;
  }
}
