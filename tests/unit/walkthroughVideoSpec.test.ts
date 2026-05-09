/**
 * v2.20.5 — walkthrough spec tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildWalkthroughVideoStep,
  ONBOARDING_VIDEO_SPECS,
  renderVideoMarkdownBody,
} from "../../src/core/walkthroughVideoSpec.js";

describe("ONBOARDING_VIDEO_SPECS", () => {
  it("ships the three planned 30-second clips", () => {
    expect(ONBOARDING_VIDEO_SPECS).toHaveLength(3);
    for (const spec of ONBOARDING_VIDEO_SPECS) {
      expect(spec.maxDurationSec).toBeLessThanOrEqual(30);
    }
  });

  it("uses unique stable ids", () => {
    const ids = new Set(ONBOARDING_VIDEO_SPECS.map((s) => s.id));
    expect(ids.size).toBe(ONBOARDING_VIDEO_SPECS.length);
  });

  it("each spec carries a non-empty storyboard", () => {
    for (const spec of ONBOARDING_VIDEO_SPECS) {
      expect(spec.storyboard.length).toBeGreaterThan(0);
    }
  });
});

describe("buildWalkthroughVideoStep", () => {
  it("emits a media.markdown reference + completion event when commandId set", () => {
    const step = buildWalkthroughVideoStep(ONBOARDING_VIDEO_SPECS[0]);
    expect(step.media.markdown).toMatch(/^media\/walkthroughs\/.+\.md$/);
    expect(step.completionEvents).toEqual(["onCommand:vscodesync.addCurrentFile"]);
  });

  it("omits completionEvents when commandId is absent", () => {
    const step = buildWalkthroughVideoStep({
      id: "extra",
      title: "T",
      description: "D",
      maxDurationSec: 30,
      width: 800,
      height: 600,
      storyboard: ["s"],
    });
    expect(step.completionEvents).toBeUndefined();
  });
});

describe("renderVideoMarkdownBody", () => {
  it("embeds a <video> tag with the right src", () => {
    const md = renderVideoMarkdownBody(ONBOARDING_VIDEO_SPECS[0]);
    expect(md).toContain('src="add-first-file.mp4"');
    expect(md).toContain("# Add a file to sync");
    expect(md).toContain("≤ 30 с");
  });
});
