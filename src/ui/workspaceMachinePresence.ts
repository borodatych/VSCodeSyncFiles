import type { ManifestMachineCacheEntry } from "../core/types.js";

const MIN30_MS = 30 * 60_000;
const H24_MS = 24 * 3600_000;

function ageMs(lastSeenIso: string): number | undefined {
  const t = Date.parse(lastSeenIso);
  if (!Number.isFinite(t)) {
    return undefined;
  }
  return Date.now() - t;
}

/** 🟢 &lt; 30 min · 🟡 30 min–24 h · 🔴 &gt; 24 h */
export function machinePresenceEmoji(lastSeen: string): string {
  const age = ageMs(lastSeen);
  if (age === undefined) {
    return "⚪";
  }
  if (age < MIN30_MS) {
    return "🟢";
  }
  if (age < H24_MS) {
    return "🟡";
  }
  return "🔴";
}

export function formatMachinePresenceRelative(lastSeen: string): string {
  const age = ageMs(lastSeen);
  if (age === undefined) {
    return "нет даты";
  }
  if (age < 60_000) {
    return "только что";
  }
  if (age < MIN30_MS) {
    return `${String(Math.round(age / 60_000))} мин. назад`;
  }
  if (age < H24_MS) {
    return `${String(Math.round(age / 3600_000))} ч. назад`;
  }
  const d = Math.round(age / H24_MS);
  return `${String(d)} дн. назад`;
}

/** Tooltip lines (markdown list items without leading dash — caller adds list formatting). */
export function formatMachinePresenceLines(
  machines: ManifestMachineCacheEntry[],
  localMachineId: string | undefined,
): string[] {
  if (machines.length === 0) {
    return ["Нет кэша машин — выполните sync или Repair State."];
  }
  const sorted = [...machines].sort((a, b) =>
    a.machineName.localeCompare(b.machineName, undefined, { sensitivity: "base" }),
  );
  return sorted.map((m) => {
    const em = machinePresenceEmoji(m.lastSeen);
    const you =
      localMachineId !== undefined && m.machineId === localMachineId ? " · сейчас (вы)" : "";
    const rel = formatMachinePresenceRelative(m.lastSeen);
    const tag =
      m.status === "pending"
        ? " · pending"
        : m.status === "blocked"
          ? " · blocked"
          : "";
    return `${em} **${m.machineName}**${you}${tag} — ${rel}`;
  });
}
