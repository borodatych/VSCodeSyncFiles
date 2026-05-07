/**
 * Cloudflare Quick Tunnel backend (skeleton).
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>`, scrapes the
 * `https://*.trycloudflare.com` URL from stderr, returns it as the public URL.
 *
 * The skeleton is gated behind a "binary present?" check — if `cloudflared`
 * is not on PATH, returns `not_available` with a clear hint. Actual spawning
 * is left commented out behind a TODO so reviewers see the intent without
 * shipping a half-tested child-process wrapper.
 */
import { spawn } from "node:child_process";
import { warnLog } from "../utils/log.js";
import type {
  TunnelBackend,
  TunnelOpenResult,
  TunnelProviderType,
} from "./tunnelProviderRegistry.js";

const TYPE: TunnelProviderType = "cloudflared";
const PROBE_TIMEOUT_MS = 3_000;

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
      try {
        child.kill();
      } catch {
        /* ignore — already exited */
      }
      resolve(ok);
    };
    child.on("error", () => { done(false); });
    child.on("exit", (code) => { done(code === 0); });
    setTimeout(() => { done(false); }, PROBE_TIMEOUT_MS);
  });
}

export const cloudflaredTunnelBackend: TunnelBackend = {
  type: TYPE,
  async open(localPort: number, _signal?: AbortSignal): Promise<TunnelOpenResult> {
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
    // TODO(v2.4): spawn `cloudflared tunnel --url http://localhost:<port>`,
    // scrape the trycloudflare.com URL from stderr, return it as channel.publicUrl.
    // Skeleton intentionally returns `not_available` until the full implementation lands.
    return {
      ok: false,
      reason: "not_available",
      detail: "cloudflared backend wiring is in skeleton mode (v2.4 in roadmap)",
    };
  },
};
