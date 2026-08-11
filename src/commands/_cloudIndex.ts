/**
 * Read-only cloud file index for UI hints (duplicate detection, bind-picker
 * ordering). Goes straight through the provider — no engine needed, same
 * pattern as `cloudWorkspaceLister` ("used by UI commands where engine is not
 * available"). Best-effort: any failure returns an empty index, the caller
 * degrades to no hints.
 */
import type { ProviderRegistry } from "../providers/registry.js";
import { manifestCloudPath, metaCloudPath, type MetaJson } from "../core/cloudLayout.js";
import { parseManifestSafe } from "../core/manifestValidate.js";
import type { CloudIndexRow } from "../core/plan/planAddDuplicates.js";
import { tryAuthenticatedProvider } from "./_providerFactory.js";

export async function readCloudFileIndex(
  registry: ProviderRegistry,
  workspaceId: string,
): Promise<CloudIndexRow[]> {
  try {
    const provider = await tryAuthenticatedProvider(registry);
    if (!provider) {
      return [];
    }
    const manifestDl = await provider.downloadFile(manifestCloudPath(workspaceId));
    const parsed = parseManifestSafe(manifestDl.body);
    if (!parsed.ok) {
      return [];
    }
    let metaFiles: MetaJson["files"] = {};
    try {
      const metaDl = await provider.downloadFile(metaCloudPath(workspaceId));
      const rawMeta: unknown = JSON.parse(metaDl.body.toString("utf8"));
      if (typeof rawMeta === "object" && rawMeta !== null && "files" in rawMeta) {
        const filesRaw: unknown = rawMeta.files;
        if (typeof filesRaw === "object" && filesRaw !== null) {
          metaFiles = filesRaw;
        }
      }
    } catch {
      /* no meta — hashes stay undefined, name matching still works */
    }
    return parsed.value.files
      .filter((f) => !f.removedAt)
      .map((f) => ({ path: f.path, linkName: f.linkName, hash: metaFiles[f.path]?.hash }));
  } catch {
    return [];
  }
}
