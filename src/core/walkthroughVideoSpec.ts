/**
 * v2.20.5 — Onboarding video walkthrough spec.
 *
 * VS Code's `contributes.walkthroughs[].steps[].media` accepts either an
 * `image` or a `markdown` reference. To embed a 30-second MP4 we render
 * markdown that includes a `<video controls>` element pointing at the
 * extension-bundled file. This module is the *pure* descriptor for the
 * three planned clips and a helper that emits the markdown body.
 *
 * Real `.mp4` files live in `media/walkthroughs/*.mp4`. The repo currently
 * only carries the `README.md` recording brief — actual recordings are a
 * blocked deliverable (need real screen captures). The walkthrough JSON in
 * `package.json` is wired up so the moment binaries land they're picked up.
 */

export interface VideoSpec {
  /** Stable id; matches the file basename (`<id>.mp4`). */
  readonly id: string;
  /** Step title shown in the walkthrough panel. */
  readonly title: string;
  /** ≤ 50 char one-liner shown above the video. */
  readonly description: string;
  /** Recommended runtime — recordings should not exceed this. */
  readonly maxDurationSec: number;
  /** Width × height target — encode at this resolution for crisp playback. */
  readonly width: number;
  readonly height: number;
  /** Storyboard for the recording (one bullet per scene). */
  readonly storyboard: readonly string[];
  /** Walkthrough event id that signals "user completed this step". */
  readonly completionCommandId?: string;
}

export const ONBOARDING_VIDEO_SPECS: readonly VideoSpec[] = [
  {
    id: "add-first-file",
    title: "Add a file to sync",
    description: "Right-click → VSCodeSync → Add file. Watch it land in the cloud.",
    maxDurationSec: 30,
    width: 1280,
    height: 720,
    storyboard: [
      "0–3 s: Explorer view, cursor on a file.",
      "3–10 s: Right-click → VSCodeSync → Add file.",
      "10–18 s: Quick-pick workspace prompt → confirm.",
      "18–25 s: Status bar updates to ✓ Synced; activity feed entry appears.",
      "25–30 s: Title card 'You can now edit it from any machine'.",
    ],
    completionCommandId: "vscodesync.addCurrentFile",
  },
  {
    id: "resolve-conflict",
    title: "Resolve a conflict",
    description: "Side-by-side diff, keep mine vs. take theirs vs. 3-way merge.",
    maxDurationSec: 30,
    width: 1280,
    height: 720,
    storyboard: [
      "0–4 s: Conflict notification appears (warning toast).",
      "4–12 s: Click 'Resolve Now' → 3-way diff opens.",
      "12–20 s: Hover over hunks; keep mine on one, take theirs on another.",
      "20–28 s: Save → conflict cleared, file syncs upward.",
      "28–30 s: Title card 'No more lost changes'.",
    ],
    completionCommandId: "vscodesync.resolveConflicts",
  },
  {
    id: "time-travel",
    title: "Time-travel through history",
    description: "Scrubber UI to jump back to any version of a file.",
    maxDurationSec: 30,
    width: 1280,
    height: 720,
    storyboard: [
      "0–4 s: Editor open with a file the user wants to revert.",
      "4–10 s: Command palette → VSCodeSync: Time-Travel Scrubber.",
      "10–22 s: Drag scrubber backward through 4 versions; live preview updates.",
      "22–28 s: Click 'Restore this version' → file reverts.",
      "28–30 s: Title card 'Every change, recoverable'.",
    ],
    completionCommandId: "vscodesync.openTimeTravelScrubber",
  },
];

export interface WalkthroughVideoStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly media: { readonly markdown: string };
  readonly completionEvents?: readonly string[];
}

/**
 * Renders the walkthrough step body that VS Code embeds. The `markdown`
 * field is a relative path to a `.md` file shipped with the extension —
 * caller writes that file to disk with `renderVideoMarkdownBody(spec)`.
 */
export function buildWalkthroughVideoStep(spec: VideoSpec): WalkthroughVideoStep {
  const completion = spec.completionCommandId
    ? [`onCommand:${spec.completionCommandId}`]
    : undefined;
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    media: { markdown: `media/walkthroughs/${spec.id}.md` },
    ...(completion ? { completionEvents: completion } : {}),
  };
}

/**
 * Markdown body that wraps the MP4 with a captioning paragraph. VS Code's
 * walkthrough markdown supports a tight subset of HTML, including `<video>`.
 */
export function renderVideoMarkdownBody(spec: VideoSpec): string {
  const lines: string[] = [];
  lines.push(`# ${spec.title}`, "");
  lines.push(spec.description, "");
  lines.push(
    `<video controls width="${String(spec.width)}" height="${String(spec.height)}" src="${spec.id}.mp4"></video>`,
    "",
  );
  lines.push(`*Длина клипа: ≤ ${String(spec.maxDurationSec)} с.*`);
  return lines.join("\n");
}
