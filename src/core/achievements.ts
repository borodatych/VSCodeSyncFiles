/**
 * Achievements — skeleton.
 *
 * Goal: gamified milestones unlocked by accumulated activity (first push,
 * 100 pulls, 10 different machines, no conflicts for 7 days, …). The pure
 * helper evaluates which achievements are unlocked given an activity event
 * stream. Persisting progress and showing a popup throws a sentinel.
 */

import type { ActivityEvent } from "./activityLog.js";

export class AchievementsNotImplementedError extends Error {
  constructor(message = "Achievements popup + persistence is not implemented yet") {
    super(message);
    this.name = "AchievementsNotImplementedError";
  }
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  unlockedAtMs: number;
}

interface AchievementRule {
  id: string;
  title: string;
  description: string;
  test(events: readonly ActivityEvent[]): number | null;
}

const RULES: AchievementRule[] = [
  {
    id: "first-push",
    title: "First push",
    description: "Pushed your first file to the cloud.",
    test: (events) => firstEventTime(events, (ev) => ev.kind === "push"),
  },
  {
    id: "first-pull",
    title: "First pull",
    description: "Pulled a file from another machine.",
    test: (events) => firstEventTime(events, (ev) => ev.kind === "pull"),
  },
  {
    id: "hundred-pushes",
    title: "100 pushes",
    description: "Pushed 100 files.",
    test: (events) => nthEventTime(events, (ev) => ev.kind === "push", 100),
  },
  {
    id: "five-machines",
    title: "Five machines",
    description: "Synced from five distinct machines.",
    test: (events) => {
      const seen = new Set<string>();
      for (const ev of events) {
        if (!ev.machineName) continue;
        seen.add(ev.machineName);
        if (seen.size === 5) return Date.parse(ev.at);
      }
      return null;
    },
  },
];

function firstEventTime(events: readonly ActivityEvent[], pred: (ev: ActivityEvent) => boolean): number | null {
  for (const ev of events) {
    if (pred(ev)) {
      const t = Date.parse(ev.at);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

function nthEventTime(
  events: readonly ActivityEvent[],
  pred: (ev: ActivityEvent) => boolean,
  n: number,
): number | null {
  let count = 0;
  for (const ev of events) {
    if (!pred(ev)) continue;
    count++;
    if (count === n) {
      const t = Date.parse(ev.at);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

export function evaluateAchievements(events: readonly ActivityEvent[]): Achievement[] {
  const unlocked: Achievement[] = [];
  for (const rule of RULES) {
    const at = rule.test(events);
    if (at !== null) {
      unlocked.push({ id: rule.id, title: rule.title, description: rule.description, unlockedAtMs: at });
    }
  }
  return unlocked;
}

export function showAchievementPopup(_a: Achievement): never {
  throw new AchievementsNotImplementedError();
}
