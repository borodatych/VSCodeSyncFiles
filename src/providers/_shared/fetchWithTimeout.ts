import { verboseLog, warnLog } from "../../utils/log.js";

/** Defaults used when a provider doesn't override. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;
export const DEFAULT_DATA_TIMEOUT_MS = 120_000;

export interface FetchWithTimeoutOptions {
  /** Log channel tag, e.g. "gdrive.fetch". Required so the caller is identifiable in Output. */
  channel: string;
  /** Timeout in ms; the request is aborted after this. */
  timeoutMs?: number;
}

/**
 * `fetch` wrapper that aborts after `timeoutMs` and traces start/end/abort
 * on the given log channel. Shared between OneDrive / GDrive / Dropbox /
 * Yandex providers so the timeout / abort behaviour is identical across the
 * stack — closes the v0.7 audit finding `B3` (provider `fetch` calls with no
 * timeout hanging the sync loop indefinitely).
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: FetchWithTimeoutOptions,
): Promise<Response> {
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const short = url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80);
  const t0 = Date.now();
  verboseLog(opts.channel, `START ${init.method ?? "GET"} ${short}`);
  const timer = setTimeout(() => {
    warnLog(opts.channel, `ABORT after ${String(timeoutMs)}ms — ${init.method ?? "GET"} ${short}`);
    ac.abort();
  }, timeoutMs);
  return fetch(url, { ...init, signal: ac.signal })
    .then((r) => {
      verboseLog(
        opts.channel,
        `DONE ${String(r.status)} in ${String(Date.now() - t0)}ms — ${short}`,
      );
      return r;
    })
    .catch((e: unknown) => {
      warnLog(
        opts.channel,
        `ERROR ${e instanceof Error ? e.message : String(e)} in ${String(Date.now() - t0)}ms — ${short}`,
      );
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
    });
}
