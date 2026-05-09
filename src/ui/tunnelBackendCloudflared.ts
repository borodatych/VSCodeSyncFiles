/**
 * Cloudflare Quick Tunnel backend (real spawn — v2.13.1).
 *
 * Probes `cloudflared --version`; if the binary is on PATH, spawns
 * `cloudflared tunnel --url http://localhost:<port> --no-autoupdate
 * --metrics 127.0.0.1:0`, scrapes the `https://*.trycloudflare.com` URL from
 * stdout/stderr (it lands on stderr in current builds, but we listen to both
 * to be future-proof), and returns it as `channel.publicUrl`.
 *
 * Open flow:
 *   1. Validate `localPort`.
 *   2. Probe binary presence (3 s timeout) — `not_available` if missing.
 *   3. Spawn the tunnel and wait up to {@link URL_DISCOVERY_TIMEOUT_MS} for
 *      the URL line. Process error / early exit / timeout collapse to
 *      `spawn_failed`; the dispatcher then falls back to smee.
 *
 * Dispose: SIGTERM → 2 s grace → SIGKILL.
 *
 * The retry/respawn watchdog ({@link createTunnelSpawnWatchdog}) is wired at
 * the dispatcher level, not here; the backend opens a single tunnel per call.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { warnLog } from "../utils/log.js";
import { scrapeTunnelUrl, isValidTunnelUrl } from "../core/tunnelUrlScrape.js";
import type {
  TunnelBackend,
  TunnelOpenResult,
  TunnelProviderType,
} from "./tunnelProviderRegistry.js";

const TYPE: TunnelProviderType = "cloudflared";
const PROBE_TIMEOUT_MS = 3_000;
const URL_DISCOVERY_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;

async function isCloudflaredOnPath(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn("cloudflared", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already exited */ }
      resolve(ok);
    };
    child.on("error", () => { done(false); });
    child.on("exit", (code) => { done(code === 0); });
    setTimeout(() => { done(false); }, PROBE_TIMEOUT_MS);
  });
}

function disposeChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.killed) {
      resolve();
      return;
    }
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (done) return;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish();
    }, KILL_GRACE_MS);
  });
}

async function openTunnelProcess(
  localPort: number,
  signal: AbortSignal | undefined,
): Promise<TunnelOpenResult> {
  let child: ChildProcess;
  try {
    child = spawn(
      "cloudflared",
      [
        "tunnel",
        "--url",
        `http://localhost:${String(localPort)}`,
        "--no-autoupdate",
        "--metrics",
        "127.0.0.1:0",
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: "spawn_failed", detail };
  }

  return new Promise<TunnelOpenResult>((resolve) => {
    let buffer = "";
    let settled = false;

    const settle = (result: TunnelOpenResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!result.ok) {
        void disposeChild(child);
      }
      resolve(result);
    };

    const onAbort = (): void => {
      settle({ ok: false, reason: "spawn_failed", detail: "aborted before URL discovery" });
    };

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    const timeout = setTimeout(() => {
      settle({
        ok: false,
        reason: "spawn_failed",
        detail: `cloudflared did not report a public URL within ${String(URL_DISCOVERY_TIMEOUT_MS / 1000)} s`,
      });
    }, URL_DISCOVERY_TIMEOUT_MS);

    const onChunk = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const found = scrapeTunnelUrl(buffer, "cloudflared");
      if (found && isValidTunnelUrl(found, "cloudflared")) {
        settle({
          ok: true,
          channel: {
            publicUrl: found,
            provider: TYPE,
            dispose: () => disposeChild(child),
          },
        });
      }
    };

    child.stderr?.on("data", onChunk);
    child.stdout?.on("data", onChunk);

    child.on("error", (err) => {
      settle({ ok: false, reason: "spawn_failed", detail: err.message });
    });

    child.on("exit", (code, sigName) => {
      settle({
        ok: false,
        reason: "spawn_failed",
        detail: `cloudflared exited (code=${String(code)}, signal=${String(sigName)}) before URL was observed`,
      });
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

export const cloudflaredTunnelBackend: TunnelBackend = {
  type: TYPE,
  async open(localPort: number, signal?: AbortSignal): Promise<TunnelOpenResult> {
    if (!Number.isFinite(localPort) || localPort <= 0) {
      return { ok: false, reason: "config_invalid", detail: "localPort must be > 0" };
    }
    const present = await isCloudflaredOnPath();
    if (!present) {
      const detail =
        "`cloudflared` не найден в PATH. Установите Cloudflare Tunnel CLI и перезапустите окно. " +
        "Получить: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
      warnLog("tunnel.cloudflared", detail);
      return { ok: false, reason: "not_available", detail };
    }
    return openTunnelProcess(localPort, signal);
  },
};
