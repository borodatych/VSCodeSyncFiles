import { describe, expect, it } from "vitest";
import {
  detectWebhookFormat,
  formatDigestForWebhook,
} from "../../src/core/digestWebhookFormatter.js";
import type { WeeklyDigest } from "../../src/core/insightsWeeklyDigest.js";

const sampleDigest = (): WeeklyDigest => ({
  windowDays: 7,
  totalEvents: 23,
  byKind: {
    push: 12, pull: 5, conflict: 2, add: 3, remove: 1,
    resolve_keep_mine: 0, resolve_take_theirs: 0,
    resolve_keep_both: 0, workspace_remote_deleted: 0, manifest_repaired: 0,
    hash_migration: 0, branch_mismatch_detected: 0,
    key_rotation_started: 0, key_rotation_completed: 0, key_rotation_resumed: 0,
    backup_verified: 0, backup_drift_detected: 0,
    quota_warning: 0, quota_critical: 0, quota_auto_pause: 0,
    share_link_used: 0, p2p_session: 0,
  },
  topFiles: [{ relPath: "src/app.ts", count: 5 }],
  topMachines: [{ machineName: "Work", count: 8 }],
  topWorkspaces: [{ workspaceId: "w1", workspaceNote: "Project", count: 12 }],
  byDay: [{ date: "2026-05-20", count: 6 }, { date: "2026-05-21", count: 17 }],
  busiestDay: { date: "2026-05-21", count: 17 },
  quietestDay: { date: "2026-05-20", count: 6 },
});

describe("detectWebhookFormat", () => {
  it("recognises discord URLs", () => {
    expect(detectWebhookFormat("https://discord.com/api/webhooks/123/abc")).toBe("discord");
  });
  it("recognises slack URLs", () => {
    expect(detectWebhookFormat("https://hooks.slack.com/services/T/B/secret")).toBe("slack");
  });
  it("recognises telegram bot URLs", () => {
    expect(detectWebhookFormat("https://api.telegram.org/bot12345/sendMessage")).toBe("telegram");
  });
  it("falls back to generic", () => {
    expect(detectWebhookFormat("https://example.com/hook")).toBe("generic");
  });
});

describe("formatDigestForWebhook", () => {
  it("discord → JSON with embeds", () => {
    const r = formatDigestForWebhook(sampleDigest(), "discord");
    expect(r.contentType).toBe("application/json");
    const body = JSON.parse(r.body) as { embeds: { title: string; fields: { name: string }[] }[] };
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0]?.title).toContain("12 push");
  });

  it("slack → JSON with blocks", () => {
    const r = formatDigestForWebhook(sampleDigest(), "slack");
    const body = JSON.parse(r.body) as { blocks: { type: string }[] };
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it("telegram → text with MarkdownV2 escape", () => {
    const r = formatDigestForWebhook(sampleDigest(), "telegram");
    const body = JSON.parse(r.body) as { text: string; parse_mode: string };
    expect(body.parse_mode).toBe("MarkdownV2");
    // src/app.ts dot should be escaped
    expect(body.text).toContain("src/app\\.ts");
  });

  it("generic → raw JSON dump", () => {
    const r = formatDigestForWebhook(sampleDigest(), "generic");
    const body = JSON.parse(r.body) as { summary: string; byKind: { push: number } };
    expect(body.summary).toContain("12 push");
    expect(body.byKind.push).toBe(12);
  });
});
