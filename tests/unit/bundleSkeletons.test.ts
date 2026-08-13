/**
 * Unwired skeletons stay out of the shipped bundle (F10).
 *
 * The plan assumed they were being shipped; checking `dist/extension.js`
 * refuted that — esbuild bundles from `src/extension.ts` and tree-shakes
 * anything nobody imports. This test pins that property, because the day one of
 * them gains a stray import from a live module, it silently starts shipping.
 *
 * Skipped when there is no build output (a bare `npm test` on a clean tree).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BUNDLE = join(__dirname, "..", "..", "dist", "extension.js");

/** Module basenames that must not appear in the bundle. */
const SKELETONS = [
  "contentDefinedChunking",
  "githubReleasesProviderPlanner",
  "passkeyOnlyMode",
  "remotePresencePlanner",
  "s3ProviderPlanner",
  "syncRewindPlanner",
  "trustedTeammatesInvitePlanner",
  "undoableActionRegistry",
  "perGlobScheduler",
  "autoPauseTickPlanner",
  // `backupVerifyScheduler` left this list when the verification flow was
  // wired (ui/backupVerify.ts): it now ships on purpose. A skeleton entering
  // the bundle is a bug only while nothing calls it.
];

describe("скелеты фазы 24 не попадают в бандл", () => {
  it.skipIf(!existsSync(BUNDLE))("ни одного имени модуля в dist/extension.js", () => {
    const bundle = readFileSync(BUNDLE, "utf8");
    const shipped = SKELETONS.filter((name) => bundle.includes(name));
    expect(shipped).toEqual([]);
  });
});
