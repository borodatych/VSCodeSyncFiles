/**
 * One place where an HTTP response becomes a {@link ProviderError} (E1).
 *
 * Before this module the four providers threw `NETWORK_ERROR` from 48 separate
 * sites and produced `UNAUTHORIZED` from exactly two, so an expired or revoked
 * token looked like "no connection": the offline queue retried it forever and
 * the "session expired — sign in again" dialog never appeared.
 *
 * The function is pure — status, body and headers in, error out — so the whole
 * table can be tested without a network. Callers pass the body text they were
 * going to put in the message anyway.
 */
import { ProviderError, type ProviderErrorCode } from "../cloudProviderTypes.js";
import { parseRetryAfterToDelayMs } from "../../utils/retryAfter.js";

export interface HttpErrorInput {
  /** Human-readable provider label used in the message, e.g. "Google Drive". */
  provider: string;
  status: number;
  /** Response body; the error reason of every one of the four APIs lives here. */
  bodyText?: string;
  /** `Retry-After` value, when the caller has the headers at hand. */
  retryAfter?: string | null;
}

/**
 * Reasons that mean "this token will not work again" rather than "try later".
 * `invalid_grant` is the OAuth token-endpoint form; the rest come from the
 * providers' own error bodies.
 */
const AUTH_REASONS = [
  "invalid_grant",
  "invalid_token",
  "expired_access_token",
  "invalid_access_token",
  "autherror",
  "unauthenticated",
  "unauthorized_client",
  "accesstokenexpired",
  "invalidauthenticationtoken",
];

/** Throttling that providers dress up as 403 (Google) or as a plain error body. */
const THROTTLE_REASONS = [
  "ratelimitexceeded",
  "userratelimitexceeded",
  "sharingratelimitexceeded",
  "too_many_requests",
  "too_many_write_operations",
  "activitylimitreached",
  "quotaexceeded",
];

/** Out of space — never worth retrying, and the user must act. */
const QUOTA_REASONS = [
  "storagequotaexceeded",
  "quotalimitreached",
  "insufficient_space",
  "insufficientstorage",
  "notenoughfreespace",
];

export function classifyProviderHttpError(input: HttpErrorInput): ProviderError {
  const body = (input.bodyText ?? "").toLowerCase();
  const retryAfterMs = parseRetryAfterToDelayMs(input.retryAfter ?? null);
  const has = (needles: string[]): boolean => needles.some((n) => body.includes(n));

  // Quota first: Google reports it as 403 and Yandex as 507, both of which
  // would otherwise be swallowed by the auth and 5xx branches below.
  if (input.status === 507 || has(QUOTA_REASONS)) {
    return make("STORAGE_QUOTA_EXCEEDED", input, "облако переполнено");
  }
  if (input.status === 401 || has(AUTH_REASONS)) {
    return make("UNAUTHORIZED", input, "требуется повторный вход");
  }
  if (input.status === 429 || input.status === 503) {
    return make("RATE_LIMITED", input, "троттлинг", retryAfterMs);
  }
  if (input.status === 403) {
    // A 403 is either throttling, a permission problem, or a revoked grant.
    // Only the body tells them apart; without a known throttle reason the safe
    // reading is "this credential cannot do it", which prompts a re-login
    // instead of an endless retry.
    return has(THROTTLE_REASONS)
      ? make("RATE_LIMITED", input, "троттлинг (403)", retryAfterMs)
      : make("UNAUTHORIZED", input, "доступ запрещён");
  }
  if (input.status === 404 || input.status === 410) {
    return make("NOT_FOUND", input, "не найдено");
  }
  if (input.status === 409 || input.status === 412 || input.status === 428) {
    return make("PRECONDITION_FAILED", input, "версия на облаке изменилась");
  }
  if (input.status >= 500 && input.status < 600) {
    return make("SERVER_ERROR", input, String(input.status));
  }
  return make("NETWORK_ERROR", input, `HTTP ${String(input.status)}`);
}

function make(
  code: ProviderErrorCode,
  input: HttpErrorInput,
  summary: string,
  retryAfterMs?: number,
): ProviderError {
  const detail = (input.bodyText ?? "").trim();
  const message = `${input.provider}: ${summary}${detail === "" ? "" : ` — ${truncate(detail)}`}`;
  return new ProviderError(code, message, retryAfterMs === undefined ? undefined : { retryAfterMs });
}

/** Provider error bodies can be whole HTML pages; the log needs the gist. */
function truncate(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * `true` for codes where repeating the same request cannot help. Used by the
 * retry envelope and by the offline queue, which must not sit on a dead token
 * or a full disk forever.
 */
export function isTerminalProviderErrorCode(code: ProviderErrorCode): boolean {
  return (
    code === "UNAUTHORIZED" ||
    code === "NOT_FOUND" ||
    code === "PRECONDITION_FAILED" ||
    code === "STORAGE_QUOTA_EXCEEDED"
  );
}
