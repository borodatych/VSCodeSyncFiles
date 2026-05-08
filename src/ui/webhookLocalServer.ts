/**
 * v2.4.1 — provider-agnostic local HTTP webhook server.
 *
 * Extracted from `graphWebhookLocalServer.ts`. The Graph-specific bit
 * (validationToken short-circuit, JSON clientState match, x-goog-channel-token
 * match) is the *handler's* problem now — this module only owns the bind /
 * body-buffer / dispose plumbing.
 *
 * Used by:
 *   - `tunnelBackendCloudflared.open` / `tunnelBackendTailscale.open` to expose
 *     a public URL via spawn'd binary.
 *   - graphWebhookLocalServer (kept as wrapper for backwards compat).
 */
import * as http from "node:http";

/** Hard cap on POST body size we are willing to buffer (DoS protection). */
export const WEBHOOK_LOCAL_SERVER_MAX_BODY_BYTES = 64 * 1024;

export interface WebhookRequest {
  method: string;
  url: string;
  /** Lowercase keys; multiple-value headers join with ", ". */
  headers: Record<string, string>;
  /** Empty buffer for GET / HEAD / no-body POST. */
  body: Buffer;
}

export interface WebhookResponse {
  status: number;
  /** Default text/plain; charset=utf-8 if `body` is set. */
  contentType?: string;
  body?: Buffer | string;
  /** Extra response headers (caller-controlled). */
  headers?: Record<string, string>;
}

export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookResponse> | WebhookResponse;

export interface LocalWebhookServer {
  /** Effective bound TCP port (after ephemeral-port allocation). */
  port: number;
  /** Close listener and free port. Idempotent. */
  dispose: () => Promise<void>;
}

export interface StartLocalWebhookServerOptions {
  /** 0 (default) → ephemeral OS-allocated port. */
  port?: number;
  /** Override DoS cap. Default `WEBHOOK_LOCAL_SERVER_MAX_BODY_BYTES`. */
  maxBodyBytes?: number;
  /** Override host. Default 127.0.0.1 (loopback only). */
  host?: string;
  handler: WebhookHandler;
}

/** Start a loopback-only HTTP listener that buffers POST bodies (capped) and
 * dispatches to `handler`. Resolves when the listener has bound; rejects on
 * bind error. The returned object's `dispose` is idempotent. */
export async function startLocalWebhookServer(
  opts: StartLocalWebhookServerOptions,
): Promise<LocalWebhookServer> {
  const port = opts.port ?? 0;
  const maxBodyBytes = opts.maxBodyBytes ?? WEBHOOK_LOCAL_SERVER_MAX_BODY_BYTES;
  const host = opts.host ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      res.writeHead(413);
      res.end();
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (d: unknown) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBufferView | string);
      total += buf.length;
      if (total > maxBodyBytes) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (aborted) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
      }
      const dispatch = (): Promise<WebhookResponse> => {
        try {
          return Promise.resolve(
            opts.handler({
              method: req.method ?? "GET",
              url: req.url ?? "/",
              headers,
              body: Buffer.concat(chunks),
            }),
          );
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      void dispatch()
        .then((response) => {
          const respHeaders: Record<string, string> = {
            "Content-Type": response.contentType ?? "text/plain; charset=utf-8",
            ...(response.headers ?? {}),
          };
          res.writeHead(response.status, respHeaders);
          if (response.body !== undefined) {
            const buf = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
            res.end(buf);
          } else {
            res.end();
          }
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => {
      reject(e);
    };
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.off("error", onErr);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    typeof addr === "object" && addr !== null && "port" in addr && typeof addr.port === "number"
      ? addr.port
      : port;

  let disposed = false;
  return {
    port: boundPort,
    dispose: () => {
      if (disposed) return Promise.resolve();
      disposed = true;
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
