/**
 * M2 — Generic S3-compatible provider — skeleton.
 *
 * Goal: support MinIO / Wasabi / Backblaze B2 / AWS S3 / any storage
 * with the S3 API. Closes the enterprise self-hosted use case (private
 * MinIO behind VPN, etc).
 *
 * `@aws-sdk/client-s3` is a large dependency (~5 MB after tree-shake);
 * for skeleton we keep the planner pure and the HTTP layer deferred —
 * actual `npm install` happens when the wiring phase commits.
 */

export interface S3ProviderConfig {
  /** Endpoint URL, e.g. `https://s3.amazonaws.com` or
   *  `https://play.min.io`. */
  endpoint: string;
  /** Bucket name; must satisfy S3 naming rules. */
  bucket: string;
  /** Region; required by SigV4 even if endpoint doesn't strictly need it. */
  region: string;
  /** Force path-style addressing (MinIO needs this). */
  forcePathStyle?: boolean;
  /** SecretStore key holding `{ accessKeyId, secretAccessKey }` JSON. */
  credentialsSecretKey: string;
}

export function isValidBucketName(name: string): boolean {
  // Simplified rules: 3-63 chars, lowercase/digits/dot/dash, no consecutive dots,
  // no IP-like format, no leading/trailing dot or dash.
  if (name.length < 3 || name.length > 63) return false;
  if (!/^[a-z0-9.-]+$/.test(name)) return false;
  if (/(\.\.|^[.-]|[.-]$)/.test(name)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return false;
  return true;
}

/** Cloud-path → S3 object key with safe prefix handling. */
export function s3ObjectKeyForCloudPath(cloudPath: string, keyPrefix = ""): string {
  const cleanCloud = cloudPath.replace(/^\/+/, "");
  const cleanPrefix = keyPrefix.replace(/^\/+|\/+$/g, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanCloud}` : cleanCloud;
}

/** Sentinel: provider not wired yet. */
export class S3ProviderNotImplementedError extends Error {
  constructor() {
    super("S3 provider: @aws-sdk/client-s3 wiring deferred (skeleton)");
    this.name = "S3ProviderNotImplementedError";
  }
}
