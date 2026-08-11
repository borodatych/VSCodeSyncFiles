/**
 * Recursive cloud-folder deletion, extracted verbatim from `syncEngine.ts`
 * (engine line-ceiling offset for the Link Bindings feature). Depends only on
 * the provider; NOT_FOUND at any level is "already gone", not an error.
 */
import type { FileMetadata, ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";

export async function deleteCloudFolderRecursive(
  provider: ICloudProvider,
  folderPath: string,
): Promise<void> {
  const asDir = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  let items: FileMetadata[];
  try {
    items = await provider.listFolder(asDir);
  } catch (e) {
    if (e instanceof ProviderError && e.code === "NOT_FOUND") {
      return;
    }
    throw e;
  }
  for (const it of items) {
    const p = it.cloudPath;
    // `isFolder` comes straight from the listing on all four providers. Only
    // when it is absent do we fall back to the old probe — which used to run
    // for every entry, including plain files that can never have children,
    // turning one delete into one extra `listFolder` per object.
    let hasChildren: boolean;
    if (it.isFolder === false) {
      hasChildren = false;
    } else if (it.isFolder === true) {
      hasChildren = true;
    } else {
      const childPrefix = p.endsWith("/") ? p : `${p}/`;
      let nested: FileMetadata[];
      try {
        nested = await provider.listFolder(childPrefix);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          nested = [];
        } else {
          throw e;
        }
      }
      hasChildren = nested.length > 0;
    }
    if (hasChildren) {
      await deleteCloudFolderRecursive(provider, p);
    }
    try {
      await provider.deleteFile(p);
    } catch (e) {
      if (!(e instanceof ProviderError && e.code === "NOT_FOUND")) {
        throw e;
      }
    }
  }
}
