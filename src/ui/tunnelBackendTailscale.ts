/**
 * Tailscale Funnel backend (real spawn — v2.13.2).
 *
 * Open flow:
 *   1. Validate `localPort`.
 *   2. Probe `tailscale --version` (3 s timeout) — `not_available` if missing.
 *   3. Pre-flight `tailscale funnel status` and feed stdout into the pure
 *      parser ({@link parseTailscaleFunnelStatus}). Reject `acl_denied` /
 *      `not_logged_in` / `daemon_unavailable` early so the dispatcher can
 *      surface a precise hint to the user.
 *   4. Spawn `tailscale funnel --bg <port>`. Tailscale exits immediately when
 *      `--bg` is set, so we then poll `tailscale funnel status` (every 2 s,
 *      timeout 15 s) and scrape the assigned `https://*.ts.net` URL with
 *      {@link scrapeTunnelUrl}.
 *   5. Dispose: `tailscale funnel reset` plus best-effort `kill` of any
 *      lingering child (the long-running daemon is owned by `tailscaled`,
 *      not us).
 *
 * No retry loop here — the dispatcher level (or the watchdog state machine
 * when wired) handles respawn.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { warnLog } from "../utils/log.js";
import { scrapeTunnelUrl, isValidTunnelUrl } from "../core/tunnelUrlScrape.js";
import { parseTailscaleFunnelStatus } from "../core/tailscaleFunnelAclParser.js";
import type {
  TunnelBackend,
  TunnelOpenResult,
  TunnelProviderType,
} from "./tunnelProviderRegistry.js";

const TYPE: TunnelProviderType = "tailscale-funnel";
const PROBE_TIMEOUT_MS = 3_000;
const STATUS_POLL_INTERVAL_MS = 2_000;
const URL_DISCOVERY_TIMEOUT_MS = 15_000;
const SPAWN_GRACE_MS = 5_000;

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
      try { child.kill(); } catch { /* already exited */ }
      resolve(ok);
    };
    child.on("error", () => { done(false); });
    child.on("exit", (code) => { done(code === 0); });
    setTimeout(() => { done(false); }, PROBE_TIMEOUT_MS);
  });
}

interface ChildOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runTailscaleCommand(args: string[], timeoutMs: number): Promise<ChildOutput> {
  return new Promise<ChildOutput>((resolve) => {
    const child = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already exited */ }
      resolve({ exitCode: code, stdout, stderr });
    };
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", () => { finish(null); });
    child.on("exit", (code) => { finish(code); });
    setTimeout(() => { finish(null); }, timeoutMs);
  });
}

async function preflightFunnelStatus(): Promise<TunnelOpenResult | null> {
  const out = await runTailscaleCommand(["funnel", "status"], PROBE_TIMEOUT_MS);
  // Tailscale puts ACL/login errors on stderr; merge to feed the parser.
  const merged = `${out.stdout}\n${out.stderr}`;
  const parsed = parseTailscaleFunnelStatus(merged);
  if (parsed.ok) {
    // `enabled: false` means Funnel is OFF but ACL would allow it; that's a
    // valid path — the spawn will turn it on for the requested port.
    return null;
  }
  if (parsed.reason === "acl_denied") {
    return { ok: false, reason: "config_invalid", detail: parsed.hint };
  }
  return { ok: false, reason: "not_available", detail: parsed.hint };
}

async function pollFunnelStatusForUrl(): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < URL_DISCOVERY_TIMEOUT_MS) {
    const out = await runTailscaleCommand(["funnel", "status"], STATUS_POLL_INTERVAL_MS);
    const merged = `${out.stdout}\n${out.stderr}`;
    const parsed = parseTailscaleFunnelStatus(merged);
    if (parsed.ok && parsed.enabled && parsed.listeningUrls.length > 0) {
      const candidate = parsed.listeningUrls[0];
      if (candidate && isValidTunnelUrl(candidate, "tailscale-funnel")) {
        return candidate;
      }
    }
    const scraped = scrapeTunnelUrl(merged, "tailscale-funnel");
    if (scraped && isValidTunnelUrl(scraped, "tailscale-funnel")) {
      return scraped;
    }
    await new Promise<void>((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  return null;
}

async function disposeFunnel(child: ChildProcess | null): Promise<void> {
  // Best-effort daemon-side reset; ignore exit code (tailscaled is the owner).
  await runTailscaleCommand(["funnel", "reset"], PROBE_TIMEOUT_MS);
  if (child?.exitCode === null && !child.killed) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
}

async function spawnFunnelBg(localPort: number): Promise<ChildProcess | TunnelOpenResult> {
  return new Promise<ChildProcess | TunnelOpenResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        "tailscale",
        ["funnel", "--bg", String(localPort)],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      resolve({ ok: false, reason: "spawn_failed", detail });
      return;
    }
    let stderr = "";
    let settled = false;
    const settle = (v: ChildProcess | TunnelOpenResult): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (err) => {
      settle({ ok: false, reason: "spawn_failed", detail: err.message });
    });
    child.on("exit", (code) => {
      // `--bg` causes tailscale to detach quickly with code=0 once the
      // funnel is registered with tailscaled. Non-zero exits surface here.
      if (code === 0) {
        settle(child);
      } else {
        settle({
          ok: false,
          reason: "spawn_failed",
          detail: `tailscale funnel exited with code ${String(code)}: ${stderr.trim() || "(no stderr)"}`,
        });
      }
    });
    setTimeout(() => { settle(child); }, SPAWN_GRACE_MS);
  });
}

async function openFunnel(
  localPort: number,
  signal: AbortSignal | undefined,
): Promise<TunnelOpenResult> {
  if (signal?.aborted) {
    return { ok: false, reason: "spawn_failed", detail: "aborted before pre-flight" };
  }
  const preflightFail = await preflightFunnelStatus();
  if (preflightFail) return preflightFail;
  if (signal?.aborted) {
    return { ok: false, reason: "spawn_failed", detail: "aborted after pre-flight" };
  }
  const spawnedOrFailed = await spawnFunnelBg(localPort);
  if (!(spawnedOrFailed instanceof Object) || "ok" in spawnedOrFailed) {
    return spawnedOrFailed;
  }
  const child = spawnedOrFailed;
  const url = await pollFunnelStatusForUrl();
  if (!url) {
    await disposeFunnel(child);
    return {
      ok: false,
      reason: "spawn_failed",
      detail: `tailscale funnel did not report a public URL within ${String(URL_DISCOVERY_TIMEOUT_MS / 1000)} s`,
    };
  }
  return {
    ok: true,
    channel: {
      publicUrl: url,
      provider: TYPE,
      dispose: () => disposeFunnel(child),
    },
  };
}

export const tailscaleFunnelTunnelBackend: TunnelBackend = {
  type: TYPE,
  async open(localPort: number, signal?: AbortSignal): Promise<TunnelOpenResult> {
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
    return openFunnel(localPort, signal);
  },
};
