/**
 * CI guard for walkthrough media references.
 *
 * Two `.vsix` releases shipped Getting Started steps whose `media.markdown`
 * wrapper embedded `<video src="…mp4">` for files that were never recorded
 * and are `.gitignore`d — users saw three broken players. VS Code resolves
 * these paths at render time, so nothing fails at build or activation.
 *
 * Scope note: this asserts the referenced files exist in the repository. It
 * does not prove they end up in the package — `.vscodeignore` could still
 * strip one. Adding a media path there is a deliberate act; recording a video
 * that does not exist is not.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

interface WalkthroughStep {
  id?: unknown;
  media?: { image?: unknown; markdown?: unknown };
}
interface Walkthrough {
  id?: unknown;
  steps?: WalkthroughStep[];
}
interface PackageJson {
  contributes?: { walkthroughs?: Walkthrough[] };
}

const repoRoot = join(__dirname, "..", "..");
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as PackageJson;

const steps = (pkg.contributes?.walkthroughs ?? []).flatMap((walkthrough) =>
  (walkthrough.steps ?? []).map((step) => ({
    label: `${String(walkthrough.id)}/${String(step.id)}`,
    media: step.media ?? {},
  })),
);

/** `<video src="x.mp4">`, `<img src='y.png'>` — the subset VS Code renders. */
const SRC_ATTRIBUTE = /\bsrc\s*=\s*["']([^"']+)["']/g;

describe("contributes.walkthroughs media", () => {
  it("declares at least one step (guard is not silently vacuous)", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  it.each(steps)("$label references media that exists", ({ media }) => {
    const reference = media.image ?? media.markdown;
    expect(typeof reference).toBe("string");
    expect(existsSync(join(repoRoot, reference as string))).toBe(true);
  });

  it("embeds no missing asset in any markdown body", () => {
    const missing: string[] = [];
    for (const { label, media } of steps) {
      if (typeof media.markdown !== "string") continue;
      const markdownPath = join(repoRoot, media.markdown);
      const body = readFileSync(markdownPath, "utf8");
      for (const [, src] of body.matchAll(SRC_ATTRIBUTE)) {
        if (/^(https?:|data:)/.test(src)) continue;
        if (!existsSync(join(dirname(markdownPath), src))) {
          missing.push(`${label}: ${media.markdown} → ${src}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
