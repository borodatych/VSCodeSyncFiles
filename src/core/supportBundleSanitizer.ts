/**
 * v0.9 F-011 — pure redactor for the support-bundle export.
 *
 * Settings can leak secrets when users put tokens directly in URL strings
 * (e.g. webhook URL with `?token=...`) or when third-party AI endpoints
 * include `Bearer ...` in headers. This helper redacts the obvious places
 * and replaces email-looking strings with `<email>`.
 *
 * Caller decides which keys to include; the sanitiser does not whitelist —
 * it redacts values regardless of key.
 */

const SECRET_LIKE_KEY_RE = /(token|secret|password|api[_-]?key|client[_-]?secret|bearer|cookie|auth)/i;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Tokens inside URL query strings: `?token=xxx&key=yyy`. */
const URL_TOKEN_PARAM_RE = /([?&](?:token|access_token|api_key|key|secret|sig|signature)=)[^&\s]+/gi;
/** Bearer / Basic auth header-like strings. */
const BEARER_RE = /(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/gi;
/** Long base64-ish opaque strings — likely credentials. */
const LONG_BASE64_RE = /\b[A-Za-z0-9+/=_-]{40,}\b/g;
/** UUID-like strings (machine ids, channel ids). */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export interface SanitizeOptions {
  /**
   * When false, keep UUIDs verbatim (machine ids, workspaceId etc) — useful
   * when the user is explicitly debugging cross-machine state. Default true.
   */
  redactUuids?: boolean;
  /**
   * When false, keep email addresses verbatim. Default true.
   */
  redactEmails?: boolean;
}

const DEFAULTS: Required<SanitizeOptions> = { redactUuids: true, redactEmails: true };

/** Redact a string value. */
export function redactString(raw: string, opts: SanitizeOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  let s = raw;
  s = s.replace(URL_TOKEN_PARAM_RE, "$1<redacted>");
  s = s.replace(BEARER_RE, "$1 <redacted>");
  if (o.redactEmails) s = s.replace(EMAIL_RE, "<email>");
  if (o.redactUuids) s = s.replace(UUID_RE, "<uuid>");
  // Only redact bare long base64 strings *after* the URL/Bearer rules so we
  // don't double-redact already-redacted markers like `<redacted>`.
  s = s.replace(LONG_BASE64_RE, (m) =>
    m.includes("<") || m.includes(">") ? m : "<redacted>",
  );
  return s;
}

/**
 * Walk a JSON-like object and redact values whose key matches secret-like
 * patterns OR whose string content matches the rules above. Returns a deep
 * copy; the input is not mutated.
 */
export function redactSettings(
  input: Record<string, unknown>,
  opts: SanitizeOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = redactValue(k, v, opts);
  }
  return out;
}

function redactValue(key: string, value: unknown, opts: SanitizeOptions): unknown {
  if (typeof value === "string") {
    if (SECRET_LIKE_KEY_RE.test(key) && value.length > 0) {
      return "<redacted>";
    }
    return redactString(value, opts);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactValue(`${key}[${String(idx)}]`, item, opts));
  }
  if (typeof value === "object") {
    return redactSettings(value as Record<string, unknown>, opts);
  }
  return null;
}

/** Build the bundle manifest (list of artifact names + size hints). Pure. */
export interface SupportBundleManifestInput {
  vscodeVersion: string;
  extensionVersion: string;
  platform: string;
  activeProvider?: string;
  activityEntriesCount: number;
  healthReportLineCount: number;
  profileSampleCount: number;
}

export interface SupportBundleManifest {
  generatedAtIso: string;
  vscodeVersion: string;
  extensionVersion: string;
  platform: string;
  activeProvider: string | null;
  contents: { name: string; description: string; itemCount?: number }[];
}

export function buildSupportBundleManifest(
  input: SupportBundleManifestInput,
  nowIso?: string,
): SupportBundleManifest {
  return {
    generatedAtIso: nowIso ?? new Date().toISOString(),
    vscodeVersion: input.vscodeVersion,
    extensionVersion: input.extensionVersion,
    platform: input.platform,
    activeProvider: input.activeProvider ?? null,
    contents: [
      { name: "metadata.json", description: "Version + provider summary" },
      { name: "settings.redacted.json", description: "vscodesync.* settings with secrets redacted" },
      { name: "activity.last7d.json", description: "Activity Feed", itemCount: input.activityEntriesCount },
      { name: "health-check.txt", description: "Latest Health Check output", itemCount: input.healthReportLineCount },
      { name: "profile-sync.txt", description: "Sync profile samples", itemCount: input.profileSampleCount },
      { name: "manifest-digest.json", description: "Per-workspace digests (no paths/hashes)" },
      { name: "log.txt", description: "Last 5000 lines of OutputChannel" },
    ],
  };
}
