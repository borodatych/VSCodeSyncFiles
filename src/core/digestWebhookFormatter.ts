/**
 * v0.16 N04 — pure formatter for Activity Feed digest delivered to a
 * user-configured webhook (Discord / Slack / Telegram bot / generic).
 *
 * Caller picks the format based on the URL's host pattern OR an explicit
 * `format` setting. We don't ship the actual HTTP POST — pure formatters
 * here; UI layer fires the request.
 */

import type { WeeklyDigest } from "./insightsWeeklyDigest.js";

export type WebhookFormat = "discord" | "slack" | "telegram" | "generic";

export interface WebhookFormatResult {
  /** Content-Type to send. */
  contentType: string;
  /** Body string to POST. */
  body: string;
}

/** Heuristic detection by URL host. */
export function detectWebhookFormat(url: string): WebhookFormat {
  const lower = url.toLowerCase();
  if (lower.includes("discord.com/api/webhooks") || lower.includes("discordapp.com")) return "discord";
  if (lower.includes("hooks.slack.com")) return "slack";
  if (lower.includes("api.telegram.org") || lower.includes("/bot")) return "telegram";
  return "generic";
}

/** Tight one-line summary of the digest. */
function oneLineSummary(d: WeeklyDigest): string {
  const total =
    d.byKind.push +
    d.byKind.pull +
    d.byKind.conflict +
    d.byKind.add +
    d.byKind.remove;
  return `VSCodeSync digest: ${String(total)} events · ${String(d.byKind.push)} push, ${String(d.byKind.pull)} pull, ${String(d.byKind.conflict)} conflict`;
}

function formatDiscord(d: WeeklyDigest): WebhookFormatResult {
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  fields.push({ name: "Push", value: String(d.byKind.push), inline: true });
  fields.push({ name: "Pull", value: String(d.byKind.pull), inline: true });
  fields.push({ name: "Conflict", value: String(d.byKind.conflict), inline: true });
  if (d.topFiles.length > 0) {
    fields.push({
      name: "Top files",
      value: d.topFiles.slice(0, 5).map((f) => `• \`${f.relPath}\` (${String(f.count)})`).join("\n"),
    });
  }
  if (d.topMachines.length > 0) {
    fields.push({
      name: "Top machines",
      value: d.topMachines.slice(0, 3).map((m) => `${m.machineName} — ${String(m.count)}`).join("\n"),
    });
  }
  const body = {
    embeds: [
      {
        title: oneLineSummary(d),
        color: 0x5865f2,
        fields,
      },
    ],
  };
  return { contentType: "application/json", body: JSON.stringify(body) };
}

function formatSlack(d: WeeklyDigest): WebhookFormatResult {
  const blocks: { type: string; text?: { type: string; text: string } }[] = [
    { type: "header", text: { type: "plain_text", text: oneLineSummary(d) } },
  ];
  if (d.topFiles.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Top files*\n" +
          d.topFiles.slice(0, 5).map((f) => `• \`${f.relPath}\` — ${String(f.count)}`).join("\n"),
      },
    });
  }
  if (d.topMachines.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Top machines*\n" +
          d.topMachines.slice(0, 3).map((m) => `• ${m.machineName} — ${String(m.count)}`).join("\n"),
      },
    });
  }
  return { contentType: "application/json", body: JSON.stringify({ blocks }) };
}

function formatTelegram(d: WeeklyDigest): WebhookFormatResult {
  const parts: string[] = [];
  parts.push(`*${escapeMarkdownV2(oneLineSummary(d))}*`);
  if (d.topFiles.length > 0) {
    parts.push("");
    parts.push("Top files:");
    for (const f of d.topFiles.slice(0, 5)) {
      parts.push(`• ${escapeMarkdownV2(f.relPath)} \\(${String(f.count)}\\)`);
    }
  }
  // Telegram bot API expects { chat_id, text, parse_mode } — caller wires chat_id.
  return {
    contentType: "application/json",
    body: JSON.stringify({ text: parts.join("\n"), parse_mode: "MarkdownV2" }),
  };
}

function escapeMarkdownV2(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function formatGeneric(d: WeeklyDigest): WebhookFormatResult {
  return {
    contentType: "application/json",
    body: JSON.stringify({
      summary: oneLineSummary(d),
      byKind: d.byKind,
      topFiles: d.topFiles,
      topMachines: d.topMachines,
      topWorkspaces: d.topWorkspaces,
      windowDays: d.windowDays,
    }),
  };
}

export function formatDigestForWebhook(
  digest: WeeklyDigest,
  format: WebhookFormat,
): WebhookFormatResult {
  switch (format) {
    case "discord": return formatDiscord(digest);
    case "slack": return formatSlack(digest);
    case "telegram": return formatTelegram(digest);
    case "generic": return formatGeneric(digest);
  }
}
