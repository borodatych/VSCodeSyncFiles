/**
 * Tailscale Funnel backend (skeleton).
 *
 * Symmetric to `tunnelBackendCloudflared.ts`: probes for `tailscale` on PATH
 * and surfaces a clear "install Tailscale + enable Funnel" hint when the
 * binary is missing. Actual `tailscale funnel <port>` spawn is left as a
 * TODO so reviewers see the intent without shipping a half-tested
 * child-process wrapper.
 *
 * Tailscale Funnel exposes a tailnet service to the public internet via
 * `*.ts.net` HTTPS, so the resulting `publicUrl` would be something like
 * `https://<machine>.<tailnet>.ts.net/`. Funnel must be enabled in the
 * tailnet's ACLs before the spawn will succeed.
 */
import { spawn } from "node:child_process";
import { warnLog } from "../utils/log.js";
import type {
  TunnelBackend,
  TunnelOpenResult,
  TunnelProviderType,
} from "./tunnelProviderRegistry.js";

const TYPE: TunnelProviderType = "tailscale-funnel";
const PROBE_TIMEOUT_MS = 3_000;

async function isTailscaleOnPath(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const child = spawn("tailscale", ["--version"], {
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

export const tailscaleFunnelTunnelBackend: TunnelBackend = {
  type: TYPE,
  async open(localPort: number, _signal?: AbortSignal): Promise<TunnelOpenResult> {
    if (!Number.isFinite(localPort) || localPort <= 0) {
      return { ok: false, reason: "config_invalid", detail: "localPort must be > 0" };
    }
    const present = await isTailscaleOnPath();
    if (!present) {
      const detail =
        "`tailscale` не найден в PATH. Установите Tailscale CLI и включите Funnel в ACL вашего tailnet. " +
        "Получить: https://tailscale.com/download · Funnel: https://tailscale.com/kb/1223/tailscale-funnel/";
      warnLog("tunnel.tailscale", detail);
      return { ok: false, reason: "not_available", detail };
    }
    // TODO(v2.4): spawn `tailscale funnel <port>` (background mode), poll
    // `tailscale funnel status` for the assigned <machine>.<tailnet>.ts.net
    // URL, return it as channel.publicUrl.
    // Skeleton intentionally returns `not_available` until the full
    // implementation lands, mirroring `tunnelBackendCloudflared.ts`.
    return {
      ok: false,
      reason: "not_available",
      detail: "tailscale-funnel backend wiring is in skeleton mode (v2.4 in roadmap)",
    };
  },
};
