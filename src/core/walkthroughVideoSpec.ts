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
 * blocked deliverable (need real screen captures). Until a clip exists its
 * spec carries `hasRecording: false`, and both helpers below degrade to the
 * static-image step every other walkthrough step already uses. Never emit a
 * `<video>` pointing at a file that is not in the package: the player renders
 * as a broken box in the Getting Started panel.
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
  /**
   * Whether `media/walkthroughs/<id>.mp4` actually ships with the extension.
   * Flip to `true` in the same commit that adds the recording — nothing else
   * has to change.
   */
  readonly hasRecording: boolean;
}

/** Stand-in artwork for steps whose clip has not been recorded yet. */
const PLACEHOLDER_IMAGE = "media/vscodesync.png";
const PLACEHOLDER_ALT_TEXT = "VSCodeSync logo";

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
    hasRecording: false,
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
    hasRecording: false,
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
    hasRecording: false,
  },
];

export type WalkthroughStepMedia =
  | { readonly markdown: string }
  | { readonly image: string; readonly altText: string };

export interface WalkthroughVideoStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly media: WalkthroughStepMedia;
  readonly completionEvents?: readonly string[];
}

/**
 * Builds the walkthrough step VS Code embeds. With a recording in hand the
 * step points at the generated `.md` wrapper (written to disk with
 * `renderVideoMarkdownBody`); without one it falls back to the static image,
 * matching the non-video steps of the same walkthrough.
 */
export function buildWalkthroughVideoStep(spec: VideoSpec): WalkthroughVideoStep {
  const completion = spec.completionCommandId
    ? [`onCommand:${spec.completionCommandId}`]
    : undefined;
  const media: WalkthroughStepMedia = spec.hasRecording
    ? { markdown: `media/walkthroughs/${spec.id}.md` }
    : { image: PLACEHOLDER_IMAGE, altText: PLACEHOLDER_ALT_TEXT };
  return {
    id: spec.id,
    title: spec.title,
    description: spec.description,
    media,
    ...(completion ? { completionEvents: completion } : {}),
  };
}

/**
 * Markdown body for a recorded clip. VS Code's walkthrough markdown supports
 * a tight subset of HTML, including `<video>`. Specs without a recording get
 * the heading and description only — an empty player is worse than no player.
 */
export function renderVideoMarkdownBody(spec: VideoSpec): string {
  const lines: string[] = [`# ${spec.title}`, "", spec.description];
  if (spec.hasRecording) {
    lines.push(
      "",
      `<video controls width="${String(spec.width)}" height="${String(spec.height)}" src="${spec.id}.mp4"></video>`,
    );
  }
  return lines.join("\n");
}
