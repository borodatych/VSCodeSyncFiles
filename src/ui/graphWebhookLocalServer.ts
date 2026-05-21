import * as http from "node:http";
import { URL } from "node:url";

/** Hard cap on POST body size we are willing to buffer (DoS protection). */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export interface StartGraphWebhookLocalServerOptions {
  port: number;
  /** Microsoft Graph `clientState` in JSON notification batches. Optional —
   *  pass `null` for a Google-Drive-only listener (no Graph notifications). */
  graphClientState: string | null;
  /** Google Drive channel `token` — must match `X-Goog-Channel-Token` on notifications. */
  googleChannelToken?: string;
  onDriveChangeHint: () => void;
}

export interface GraphWebhookLocalServer {
  close: () => void;
  /** Effective TCP port after bind (when `opts.port` is 0, OS assigns a free port). */
  port: number;
}

/**
 * Local HTTP listener for Microsoft Graph webhook validation/notifications and Google Drive push.
 * Graph: GET/POST with ?validationToken=. Drive: POST with matching X-Goog-Channel-Token.
 */
export async function startGraphWebhookLocalServer(
  opts: StartGraphWebhookLocalServerOptions,
): Promise<GraphWebhookLocalServer> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const validation = u.searchParams.get("validationToken");

    if (validation && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "POST") {
        req.resume();
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(validation, "utf8");
      return;
    }

    if (req.method === "POST") {
      const googHeader = req.headers["x-goog-channel-token"];
      const wantGoog = opts.googleChannelToken;
      if (
        wantGoog !== undefined &&
        wantGoog.length > 0 &&
        typeof googHeader === "string" &&
        googHeader === wantGoog
      ) {
        req.resume();
        opts.onDriveChangeHint();
        res.writeHead(200);
        res.end();
        return;
      }

      const declared = Number(req.headers["content-length"] ?? "0");
      if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
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
        let buf: Buffer;
        if (Buffer.isBuffer(d)) {
          buf = d;
        } else if (typeof d === "string") {
          buf = Buffer.from(d);
        } else if (ArrayBuffer.isView(d)) {
          // ArrayBufferView (Uint8Array, etc.) — copy through to a Buffer.
          const view = d;
          buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        } else {
          // Unexpected shape — drop chunk; node http only ever emits Buffer/string.
          return;
        }
        total += buf.length;
        if (total > MAX_WEBHOOK_BODY_BYTES) {
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
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw.length > 0 && opts.graphClientState !== null) {
            const j = JSON.parse(raw) as { value?: { clientState?: string }[] };
            const ok = j.value?.some((v) => v.clientState === opts.graphClientState) ?? false;
            if (ok) {
              opts.onDriveChangeHint();
            }
          }
        } catch {
          /* malformed body */
        }
        res.writeHead(202);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => {
      reject(e);
    };
    server.once("error", onErr);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", onErr);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    typeof addr === "object" && addr !== null && "port" in addr && typeof addr.port === "number"
      ? addr.port
      : opts.port;

  return {
    port: boundPort,
    close: () => {
      server.close();
    },
  };
}
