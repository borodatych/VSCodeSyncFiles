/**
 * One dial for how often the extension polls the cloud on its own initiative.
 *
 * Three pollers each carried their own literal — connectivity probe 30 s,
 * presence 60 s, machine approvals 75 s — and the user had no way to turn any
 * of them down. On a metered connection or a laptop on battery that is exactly
 * the knob people reach for, and "edit three constants and rebuild" is not a
 * knob.
 *
 * The profile multiplies the base interval instead of replacing it, so the
 * relative rhythm each poller was tuned for survives: presence stays slower
 * than the connectivity probe at every setting.
 *
 * Pure — the VS Code lookup lives in the caller.
 */

export type BackgroundPollProfile = "normal" | "relaxed" | "minimal" | "off";

/** Multipliers chosen so `minimal` keeps hourly-ish contact rather than none. */
const FACTOR: Record<Exclude<BackgroundPollProfile, "off">, number> = {
  normal: 1,
  relaxed: 4,
  minimal: 20,
};

export function parseBackgroundPollProfile(raw: string | undefined): BackgroundPollProfile {
  switch (raw) {
    case "relaxed":
    case "minimal":
    case "off":
      return raw;
    default:
      return "normal";
  }
}

/**
 * Interval for a poller whose tuned base is `baseMs`.
 *
 * Returns `null` for `off` — the caller must then not arm the timer at all.
 * A huge number would have been the smaller change and the wrong one: a timer
 * that fires once a day is still a timer that fires.
 */
export function pollIntervalMs(
  baseMs: number,
  profile: BackgroundPollProfile,
): number | null {
  if (profile === "off") {
    return null;
  }
  return baseMs * FACTOR[profile];
}

/** Human summary for the settings panel and the status-bar tooltip. */
export function describeBackgroundPollProfile(profile: BackgroundPollProfile): string {
  switch (profile) {
    case "normal":
      return "обычный — проверки идут в штатном ритме";
    case "relaxed":
      return "щадящий — обращений к облаку вчетверо меньше";
    case "minimal":
      return "минимальный — фоновые проверки редкие, для медленной или платной сети";
    case "off":
      return "выключен — фоновых опросов нет, только по вашей команде";
  }
}
