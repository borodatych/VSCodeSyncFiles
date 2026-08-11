/**
 * v2.20.5 — walkthrough spec tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildWalkthroughVideoStep,
  ONBOARDING_VIDEO_SPECS,
  renderVideoMarkdownBody,
  type VideoSpec,
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

const RECORDED: VideoSpec = {
  id: "add-first-file",
  title: "Add a file to sync",
  description: "D",
  maxDurationSec: 30,
  width: 1280,
  height: 720,
  storyboard: ["s"],
  completionCommandId: "vscodesync.addCurrentFile",
  hasRecording: true,
};

describe("buildWalkthroughVideoStep", () => {
  it("emits a media.markdown reference + completion event once recorded", () => {
    const step = buildWalkthroughVideoStep(RECORDED);
    expect(step.media).toEqual({ markdown: "media/walkthroughs/add-first-file.md" });
    expect(step.completionEvents).toEqual(["onCommand:vscodesync.addCurrentFile"]);
  });

  it("falls back to the static image while the clip is unrecorded", () => {
    const step = buildWalkthroughVideoStep({ ...RECORDED, hasRecording: false });
    expect(step.media).toEqual({
      image: "media/vscodesync.png",
      altText: "VSCodeSync logo",
    });
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
      hasRecording: false,
    });
    expect(step.completionEvents).toBeUndefined();
  });
});

describe("renderVideoMarkdownBody", () => {
  it("embeds a <video> tag with the right src once recorded", () => {
    const md = renderVideoMarkdownBody(RECORDED);
    expect(md).toContain('src="add-first-file.mp4"');
    expect(md).toContain("# Add a file to sync");
  });

  it("never emits a <video> for a clip that does not exist yet", () => {
    for (const spec of ONBOARDING_VIDEO_SPECS.filter((s) => !s.hasRecording)) {
      expect(renderVideoMarkdownBody(spec)).not.toContain("<video");
    }
  });
});
