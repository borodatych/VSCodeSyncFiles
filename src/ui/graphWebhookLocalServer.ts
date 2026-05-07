import * as http from "node:http";
import { URL } from "node:url";

export interface StartGraphWebhookLocalServerOptions {
  port: number;
  /** Microsoft Graph `clientState` in JSON notification batches. */
  graphClientState: string;
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

      const chunks: Buffer[] = [];
      req.on("data", (d) => {
        chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      });
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw.length > 0) {
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
