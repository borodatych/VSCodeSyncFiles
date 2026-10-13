import { verboseLog, warnLog } from "../../utils/log.js";
import { describeTransportFailure } from "../../core/transportFailureReason.js";

/** Defaults used when a provider doesn't override. */
export const DEFAULT_API_TIMEOUT_MS = 30_000;
export const DEFAULT_DATA_TIMEOUT_MS = 120_000;
/**
 * A download that is alive delivers bytes continuously; twenty silent seconds
 * mean the connection is dead, and waiting out the whole ceiling only delays
 * the retry that would have picked another storage node.
 */
export const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 20_000;

export interface FetchWithTimeoutOptions {
  /** Log channel tag, e.g. "gdrive.fetch". Required so the caller is identifiable in Output. */
  channel: string;
  /** Timeout in ms covering the whole exchange, headers and body alike. */
  timeoutMs?: number;
  /**
   * Abort when no byte arrives for this long. `timeoutMs` stays as the overall
   * ceiling. Unset → {@link DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS} for data GETs,
   * none otherwise: an upload legitimately hears nothing until it is done.
   */
  idleTimeoutMs?: number;
  /** Shown in log lines instead of the URL path — e.g. the cloud path being fetched. */
  label?: string;
  /** Caller-supplied cancellation, combined with the deadline. */
  signal?: AbortSignal;
}

/**
 * Statuses that must not carry a body. Constructing a `Response` with a body
 * for any of these throws, so the buffered value stays `null`.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Thrown when the deadline fires. Distinguishable from a caller cancellation. */
export class FetchTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly urlPath: string,
  ) {
    super(`Request timed out after ${String(timeoutMs)}ms — ${urlPath}`);
    this.name = "FetchTimeoutError";
  }
}

/**
 * `fetch` wrapper with a deadline that covers the **entire** exchange.
 *
 * The previous version cleared the timer in `.finally()` on the fetch promise,
 * which settles as soon as response headers arrive. Everything after that — and
 * that is every byte of every download and every `await res.json()` — ran with a
 * disarmed AbortController and therefore no timeout at all. In the desktop host
 * undici's `bodyTimeout` restarts on each chunk, so a server dribbling bytes had
 * no ceiling whatsoever; in the web build there was no ceiling to begin with.
 *
 * The fix reads the body here, under the same signal, and clears the timer only
 * once the body is fully in memory. The returned `Response` is a faithful copy
 * carrying that buffer, so callers keep using `res.ok`, `res.status`,
 * `res.headers` and `await res.json() / .text() / .arrayBuffer()` unchanged.
 * Buffering costs nothing in practice: every call site already materialised the
 * whole body, and no caller touches `res.body`, `res.url` or `res.redirected`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: FetchWithTimeoutOptions,
): Promise<Response> {
  const ac = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const method = init.method ?? "GET";
  const short = opts.label ?? url.replace(/^https?:\/\/[^/]+/, "").slice(0, 80);
  const idleMs =
    opts.idleTimeoutMs ??
    (method === "GET" && timeoutMs >= DEFAULT_DATA_TIMEOUT_MS ? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS : undefined);
  const t0 = Date.now();

  let timedOut = false;
  verboseLog(opts.channel, `START ${method} ${short}`);
  const timer = setTimeout(() => {
    timedOut = true;
    warnLog(opts.channel, `ABORT after ${String(timeoutMs)}ms — ${method} ${short}`);
    ac.abort();
  }, timeoutMs);

  let stalled = false;
  // What the stall line reports: a silent host before any header is a routing
  // or server problem, silence after N bytes is a transfer that died midway.
  let gotHeaders = false;
  let receivedBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    if (idleMs === undefined) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      const phase = gotHeaders ? `после ${String(receivedBytes)} байт` : "заголовки не пришли";
      warnLog(opts.channel, `STALL no data for ${String(idleMs)}ms (${phase}) — ${method} ${short}`);
      ac.abort();
    }, idleMs);
  };
  armIdle();

  const onCallerAbort = (): void => {
    ac.abort();
  };
  opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (opts.signal?.aborted === true) ac.abort();

  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    gotHeaders = true;
    armIdle();
    // Body is read here on purpose: the deadline must outlive the headers.
    const buffered = NULL_BODY_STATUSES.has(res.status)
      ? null
      : idleMs === undefined || res.body === null
        ? await res.arrayBuffer()
        : await readBodyResettingIdle(res.body, (n) => {
            receivedBytes += n;
            armIdle();
          });
    verboseLog(
      opts.channel,
      `DONE ${String(res.status)} in ${String(Date.now() - t0)}ms — ${short}`,
    );
    return new Response(buffered, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (e: unknown) {
    // Log the unwrapped cause, not `fetch failed`: a log full of the outer
    // message cannot tell a blocked port from a dead DNS, and that difference
    // is the entire diagnosis.
    const msg = describeTransportFailure(e).text;
    warnLog(opts.channel, `ERROR ${msg} in ${String(Date.now() - t0)}ms — ${short}`);
    // An abort raised by our own timer is a timeout, not a cancellation: say so,
    // otherwise the caller sees a bare "The operation was aborted".
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- timedOut is set inside the timer callback, invisible to flow analysis
    if (timedOut) throw new FetchTimeoutError(timeoutMs, `${method} ${short}`);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- set inside the idle timer callback
    if (stalled) throw new FetchTimeoutError(idleMs ?? 0, `${method} ${short} (нет данных)`);
    throw e;
  } finally {
    clearTimeout(timer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Read a body to the end, re-arming the idle timer on every chunk. */
async function readBodyResettingIdle(
  body: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void,
): Promise<ArrayBuffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}
