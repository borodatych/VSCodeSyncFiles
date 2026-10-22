import { ProviderError } from "../providers/cloudProviderTypes.js";
import { CLOUD_ROOT_DIR, manifestCloudPath, metaCloudPath } from "./cloudLayout.js";

export interface BrokenCloudFile {
  kind: "meta" | "manifest";
  workspaceId: string;
}

/**
 * Узнаёт ошибку «облако не отдаёт служебный файл воркспейса».
 * Признак структурный: код SERVER_ERROR и cloudPath ошибки, текст сообщения не разбирается.
 */
export function detectBrokenCloudFile(err: unknown): BrokenCloudFile | null {
  if (!(err instanceof ProviderError) || err.code !== "SERVER_ERROR" || !err.cloudPath) {
    return null;
  }
  const path = err.cloudPath.replace(/^\/+/, "");
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== CLOUD_ROOT_DIR) {
    return null;
  }
  const workspaceId = parts[1];
  if (path === metaCloudPath(workspaceId)) {
    return { kind: "meta", workspaceId };
  }
  if (path === manifestCloudPath(workspaceId)) {
    return { kind: "manifest", workspaceId };
  }
  return null;
}
