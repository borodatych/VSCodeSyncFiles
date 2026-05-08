/**
 * v2.2.5 — pure formatter for the `vscodesync.showPasskeySettings`
 * webview that lists enrolled WebAuthn / FIDO2 devices.
 *
 * Two surfaces:
 *   - `parseDeviceUserAgent(uaString)` — heuristic to derive a friendly
 *     device label ("Chrome 124 on macOS 14") from a stored user-agent.
 *   - `renderPasskeyDevicesHtml(devices, options?)` — full HTML body for
 *     the webview, escape-safe for arbitrary stored displayName / UA.
 *
 * No `vscode` import. Caller renders into a `WebviewPanel` and intercepts
 * the action commands ("rename", "remove", "regenerate-codes") via
 * `webview.onDidReceiveMessage`.
 */

import { escapeHtml } from "./htmlEscape.js";

export interface PasskeyDeviceEntry {
  /** Stable id (credential id hex prefix, or UUID). */
  id: string;
  /** User-supplied or auto-generated display name. */
  displayName: string;
  /** Raw user-agent recorded at enrollment. */
  userAgent: string;
  /** ms timestamp the device was enrolled. */
  enrolledAtMs: number;
  /** ms timestamp the device was last used to unlock. null when never used
   * after enrollment. */
  lastUsedAtMs: number | null;
}

export interface ParsedDeviceLabel {
  /** Normalised browser name (Chrome / Firefox / Safari / Edge / Other). */
  browser: string;
  /** Major version when extractable, else empty string. */
  browserVersion: string;
  /** Normalised OS name (Windows / macOS / Linux / iOS / Android / Other). */
  os: string;
  /** OS major version when extractable, else empty string. */
  osVersion: string;
  /** Combined "Browser N on OS M" for UI display. */
  combined: string;
}

const BROWSER_PATTERNS: { name: string; re: RegExp }[] = [
  // Edge must come before Chrome (Edge UA contains "Chrome").
  { name: "Edge", re: /Edg\/(\d+)/ },
  { name: "Chrome", re: /Chrome\/(\d+)/ },
  { name: "Firefox", re: /Firefox\/(\d+)/ },
  // Safari must come last because Chrome UA contains "Safari".
  { name: "Safari", re: /Version\/(\d+).+Safari/ },
];

const OS_PATTERNS: { name: string; re: RegExp; versionGroup?: number }[] = [
  { name: "Windows", re: /Windows NT (\d+\.\d+)/ },
  { name: "macOS", re: /Mac OS X (\d+[._]\d+)/ },
  { name: "iOS", re: /iPhone OS (\d+_\d+)/ },
  { name: "Android", re: /Android (\d+)/ },
  { name: "Linux", re: /(Linux)/, versionGroup: 0 },
];

export function parseDeviceUserAgent(uaString: string): ParsedDeviceLabel {
  let browser = "Other";
  let browserVersion = "";
  for (const p of BROWSER_PATTERNS) {
    const m = p.re.exec(uaString);
    if (m) {
      browser = p.name;
      browserVersion = m[1];
      break;
    }
  }
  let os = "Other";
  let osVersion = "";
  for (const p of OS_PATTERNS) {
    const m = p.re.exec(uaString);
    if (m) {
      os = p.name;
      if (p.versionGroup !== 0) osVersion = m[1].replace(/_/g, ".");
      break;
    }
  }
  const browserPart = browserVersion === "" ? browser : `${browser} ${browserVersion}`;
  const osPart = osVersion === "" ? os : `${os} ${osVersion}`;
  const combined = browser === "Other" && os === "Other" ? "Unknown device" : `${browserPart} on ${osPart}`;
  return { browser, browserVersion, os, osVersion, combined };
}

export interface RenderPasskeyDevicesHtmlOptions {
  /** Format absolute date for "enrolled" + "last used" rows. Defaults to
   * `new Date(ms).toISOString().slice(0, 10)` (YYYY-MM-DD). */
  formatDate?: (ms: number) => string;
  /** Title shown above the device list. */
  title?: string;
  /** Optional CSS nonce for the inline style block. Caller passes
   * `webview.cspSource` + nonce into the HTML if strict CSP is on. */
  styleNonce?: string;
}

/** Render the full HTML body. Output is XSS-safe for arbitrary
 * `displayName` / `userAgent` values (every interpolation goes through
 * `escapeHtml`). */
export function renderPasskeyDevicesHtml(
  devices: readonly PasskeyDeviceEntry[],
  options: RenderPasskeyDevicesHtmlOptions = {},
): string {
  const formatDate = options.formatDate ?? defaultFormatDate;
  const title = options.title ?? "Passkey devices";
  const nonceAttr = options.styleNonce !== undefined ? ` nonce="${escapeHtml(options.styleNonce)}"` : "";

  const sortedRows = [...devices].sort(
    (a, b) => b.enrolledAtMs - a.enrolledAtMs,
  );

  const body = sortedRows.length === 0
    ? "<p class=\"empty\">No passkeys enrolled yet.</p>"
    : `<ul class="device-list">${sortedRows.map((d) => renderRow(d, formatDate)).join("")}</ul>`;

  return [
    "<!DOCTYPE html>",
    "<html><head>",
    `<style${nonceAttr}>`,
    "body { font-family: var(--vscode-font-family); padding: 1em; }",
    ".device-list { list-style: none; padding: 0; margin: 0; }",
    ".device-row { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }",
    ".device-name { font-weight: 600; }",
    ".device-meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; }",
    ".device-actions { margin-top: 4px; }",
    ".device-actions button { margin-right: 8px; }",
    ".empty { color: var(--vscode-descriptionForeground); }",
    "</style>",
    "</head><body>",
    `<h2>${escapeHtml(title)}</h2>`,
    body,
    "</body></html>",
  ].join("\n");
}

function renderRow(d: PasskeyDeviceEntry, formatDate: (ms: number) => string): string {
  const parsed = parseDeviceUserAgent(d.userAgent);
  const lastUsed = d.lastUsedAtMs === null ? "never" : formatDate(d.lastUsedAtMs);
  return [
    `<li class="device-row" data-id="${escapeHtml(d.id)}">`,
    `<div class="device-name">${escapeHtml(d.displayName)}</div>`,
    `<div class="device-meta">${escapeHtml(parsed.combined)}</div>`,
    `<div class="device-meta">Enrolled ${escapeHtml(formatDate(d.enrolledAtMs))} · Last used ${escapeHtml(lastUsed)}</div>`,
    `<div class="device-actions">`,
    `<button data-action="rename" data-id="${escapeHtml(d.id)}">Rename</button>`,
    `<button data-action="remove" data-id="${escapeHtml(d.id)}">Remove</button>`,
    `</div>`,
    `</li>`,
  ].join("");
}

function defaultFormatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
