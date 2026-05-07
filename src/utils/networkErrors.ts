import { ProviderError } from "../providers/cloudProviderTypes.js";

const UNREACHABLE_ERR_CODES = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function errCodeFromUnknown(e: unknown): string | undefined {
  if (!e || typeof e !== "object") {
    return undefined;
  }
  const o = e as { code?: unknown; cause?: unknown };
  if (typeof o.code === "string") {
    return o.code;
  }
  if (typeof o.code === "number") {
    return String(o.code);
  }
  return errCodeFromUnknown(o.cause);
}

/**
 * True when the error likely means no route to cloud (vs auth, ETag, or rate limit).
 */
export function isLikelyUnreachableError(e: unknown): boolean {
  if (e instanceof ProviderError) {
    if (e.code === "RATE_LIMITED" || e.code === "UNAUTHORIZED" || e.code === "PRECONDITION_FAILED") {
      return false;
    }
    return e.code === "NETWORK_ERROR";
  }
  const code = errCodeFromUnknown(e);
  if (code && UNREACHABLE_ERR_CODES.has(code)) {
    return true;
  }
  if (e instanceof TypeError) {
    const m = e.message.toLowerCase();
    return m.includes("fetch") || m.includes("network") || m.includes("terminated");
  }
  return false;
}
