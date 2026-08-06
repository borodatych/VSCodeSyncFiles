/**
 * What every provider does with a response before handing it back (E5/E8/E9/E12).
 *
 * The four fetch wrappers each had their own idea of this: Google looked at
 * 429/503 only, so a 403 `userRateLimitExceeded` — Drive's usual way of saying
 * "slow down" — never even reached the retry envelope; Dropbox had no envelope
 * at all, so a single 500 killed a push that OneDrive would have survived; and
 * a full cloud (403 `storageQuotaExceeded`, 507) was retried as a 5xx by three
 * of them.
 *
 * Errors thrown from here happen **inside** `withRetry`, which is the whole
 * point: the retry policy can only act on what it is allowed to see.
 */
import {
  noteProviderRateLimited,
  noteProviderRequestSuccess,
} from "../../core/syncRateLimitState.js";
import {
  noteCloudTransportFailure,
  noteCloudTransportSuccess,
} from "../../core/syncOfflineHints.js";
import { ProviderError } from "../cloudProviderTypes.js";
import { classifyProviderHttpError } from "./classifyHttpError.js";

/**
 * Classify a response and throw whatever the caller must not paper over.
 *
 * Returns the response untouched (body unread) for statuses that carry real
 * meaning to the calling method — 404 as "absent", 412 as "cloud moved" — so
 * those stay local decisions.
 */
export async function inspectProviderResponse(r: Response, provider: string): Promise<Response> {
  if (r.ok || r.status === 304) {
    noteProviderRequestSuccess();
    // Reporting the fact is all the transport does; the offline-flush policy
    // subscribes to this signal and resets its backoff (E12/F6).
    noteCloudTransportSuccess();
    return r;
  }
  // `clone()` keeps the caller's body readable. Error bodies are small; this
  // never runs on a successful download.
  const bodyText = await r.clone().text().catch(() => "");
  const err = classifyProviderHttpError({
    provider,
    status: r.status,
    bodyText,
    retryAfter: r.headers.get("Retry-After"),
  });
  if (err.code === "RATE_LIMITED") {
    noteProviderRateLimited(err.retryAfterMs);
    throw err;
  }
  if (
    err.code === "SERVER_ERROR" ||
    err.code === "STORAGE_QUOTA_EXCEEDED" ||
    err.code === "UNAUTHORIZED"
  ) {
    throw err;
  }
  return r;
}

/**
 * Transport-level failure (no response at all). Kept next to its counterpart so
 * both halves of the outcome live in one file.
 *
 * Note what is *not* here: the global offline backoff is no longer bumped from
 * the transport layer (E12). It used to fire once per `withRetry` attempt, so a
 * ten-second Wi-Fi drop pushed the shared 15 s → 300 s counter three steps at
 * once. Bumping belongs to the operation that failed as a whole.
 */
export function providerTransportError(e: unknown, provider: string): ProviderError {
  if (e instanceof ProviderError) {
    return e;
  }
  noteCloudTransportFailure();
  return new ProviderError(
    "NETWORK_ERROR",
    `${provider}: ${e instanceof Error ? e.message : String(e)}`,
    { cause: e },
  );
}
