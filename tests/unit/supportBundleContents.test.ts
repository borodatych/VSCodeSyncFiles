/**
 * The support bundle must contain everything its own manifest advertises.
 *
 * Before 1.0.0 `metadata.json` listed seven files while the exporter wrote two:
 * anyone who received a bundle believed it held an activity log, a health check,
 * sync profile samples, per-workspace digests and 5000 lines of Output, and
 * diagnosed a hang without any of them. The union type stops a typo in a file
 * name; only this test stops a file from being dropped altogether.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORT_BUNDLE_FILES } from "../../src/core/supportBundleContents.js";
import { buildSupportBundleManifest } from "../../src/core/supportBundleSanitizer.js";

const EXPORTER = join(
  __dirname,
  "..",
  "..",
  "src",
  "commands",
  "registerPhase21Commands.ts",
);

describe("support bundle: манифест ↔ то, что реально пишется", () => {
  const source = readFileSync(EXPORTER, "utf8");

  it("экспортёр пишет каждый файл, объявленный в SUPPORT_BUNDLE_FILES", () => {
    const missing = SUPPORT_BUNDLE_FILES.filter(
      (spec) => !source.includes(`"${spec.name}"`),
    ).map((spec) => spec.name);
    expect(missing).toEqual([]);
  });

  it("манифест перечисляет ровно тот же набор файлов", () => {
    const manifest = buildSupportBundleManifest(
      {
        vscodeVersion: "1.131.0",
        extensionVersion: "1.0.0",
        platform: "darwin",
        activityEntriesCount: 3,
        healthReportLineCount: 12,
        profileSampleCount: 7,
      },
      "2026-07-30T00:00:00.000Z",
    );
    expect(manifest.contents.map((c) => c.name)).toEqual(
      SUPPORT_BUNDLE_FILES.map((s) => s.name),
    );
  });

  it("счётчики попадают только в файлы, помеченные counted", () => {
    const manifest = buildSupportBundleManifest(
      {
        vscodeVersion: "1.131.0",
        extensionVersion: "1.0.0",
        platform: "darwin",
        activityEntriesCount: 3,
        healthReportLineCount: 12,
        profileSampleCount: 7,
      },
      "2026-07-30T00:00:00.000Z",
    );
    const withCount = manifest.contents
      .filter((c) => c.itemCount !== undefined)
      .map((c) => c.name)
      .sort();
    const declaredCounted = SUPPORT_BUNDLE_FILES.filter((s) => s.counted)
      .map((s) => s.name)
      .sort();
    expect(withCount).toEqual(declaredCounted);
    expect(manifest.contents.find((c) => c.name === "activity.last7d.json")?.itemCount).toBe(3);
    expect(manifest.contents.find((c) => c.name === "health-check.txt")?.itemCount).toBe(12);
    expect(manifest.contents.find((c) => c.name === "profile-sync.txt")?.itemCount).toBe(7);
  });

  it("настройки в bundle перечисляются из манифеста расширения, а не из захардкоженного списка", () => {
    // The previous implementation sampled nine names and said so in a comment.
    expect(source).not.toContain("KNOWN_KEYS");
    expect(source).toContain("contributes?.configuration?.properties");
  });
});
