import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

const EXEC_OPTS = { timeout: 12000, maxBuffer: 512 * 1024, windowsHide: true } as const;

/**
 * Rough estimate of battery charge [0..100], or null if desktop AC-only / unknown / error.
 */
export async function readBatteryPercent(platform: NodeJS.Platform = process.platform): Promise<number | null> {
  try {
    if (platform === "win32") {
      return await readBatteryPercentWindows();
    }
    if (platform === "darwin") {
      return await readBatteryPercentDarwin();
    }
    return await readBatteryPercentLinux();
  } catch {
    return null;
  }
}

async function readBatteryPercentWindows(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Battery | Select-Object -ExpandProperty EstimatedChargeRemaining",
      ],
      EXEC_OPTS,
    );
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    if (lines.length === 0) {
      return null;
    }
    return Math.min(...lines);
  } catch {
    return null;
  }
}

/** Exported for tests — parses `pmset -g batt` output. */
export function parsePmsetBatteryPercent(output: string): number | null {
  const m = /(\d{1,3})%/.exec(output);
  const rawPct = m?.[1];
  if (rawPct === undefined) {
    return null;
  }
  const n = Number.parseInt(rawPct, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

async function readBatteryPercentDarwin(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("pmset", ["-g", "batt"], EXEC_OPTS);
    return parsePmsetBatteryPercent(stdout);
  } catch {
    return null;
  }
}

async function readBatteryPercentLinux(): Promise<number | null> {
  const bases = ["/sys/class/power_supply/BAT0", "/sys/class/power_supply/BAT1"];
  for (const base of bases) {
    try {
      const cap = path.join(base, "capacity");
      const raw = await fs.readFile(cap, "utf8");
      const n = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(n) && n >= 0 && n <= 100) {
        return n;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}
