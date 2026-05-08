/**
 * v3.H — pure prompt builder for the AI bulk-review pass.
 *
 * `bulkPushWizard` collects the per-file `{ relPath, localContent,
 * cloudContent }` triples; this module builds the LM prompt and reduces the
 * model's free-form response into a `BulkReviewVerdict`.
 *
 * No `vscode` import. No `vscode.lm` call here either — caller hands the
 * built prompt to `vscode.lm.selectChatModels(...).sendRequest(...)` and
 * feeds the streamed text back through `parseBulkReviewVerdict`.
 */

export interface BulkReviewInput {
  relPath: string;
  /** Truncate to N chars before passing in — caller decides. */
  localContent: string;
  cloudContent: string;
}

export interface BulkReviewVerdict {
  relPath: string;
  /** 0..1 — how risky is the cloud→local overwrite. */
  riskScore: number;
  /** Short human-readable summary suitable for a list row. */
  summary: string;
}

const MAX_CONTENT_CHARS_PER_FILE = 4_000;

/** Build a single LM prompt for one file. The output expects the model to
 * answer in JSON: { riskScore: 0..1, summary: "<≤120 chars>" }. */
export function buildBulkReviewPrompt(input: BulkReviewInput): string {
  const local = truncate(input.localContent, MAX_CONTENT_CHARS_PER_FILE);
  const cloud = truncate(input.cloudContent, MAX_CONTENT_CHARS_PER_FILE);
  return [
    "You are reviewing a sync operation that would replace the local file with the cloud version.",
    `Path: ${input.relPath}`,
    "",
    "Reply ONLY with one JSON object on a single line:",
    `{"riskScore": <0..1>, "summary": "<short human-readable summary, ≤ 120 chars>"}`,
    "Where riskScore = 1 means 'highly risky to overwrite local' and 0 means 'safe overwrite'.",
    "",
    "=== LOCAL VERSION ===",
    local,
    "=== CLOUD VERSION ===",
    cloud,
  ].join("\n");
}

/** Build a small batch prompt for N files. Caller decides whether to do
 * one-shot batch or N individual calls; the batch prompt is denser but the
 * model may forget structure for ≥ 30 files. Default keep N ≤ 10. */
export function buildBulkReviewBatchPrompt(inputs: BulkReviewInput[]): string {
  const sections = inputs.map((i, ix) => {
    const local = truncate(i.localContent, MAX_CONTENT_CHARS_PER_FILE);
    const cloud = truncate(i.cloudContent, MAX_CONTENT_CHARS_PER_FILE);
    return [
      `--- FILE #${String(ix + 1)}: ${i.relPath} ---`,
      "LOCAL:",
      local,
      "CLOUD:",
      cloud,
    ].join("\n");
  });
  return [
    "You are reviewing a sync operation that would replace local files with cloud versions.",
    `For each of the ${String(inputs.length)} files below, reply with ONE JSON object per line:`,
    `{"file": "<relPath>", "riskScore": <0..1>, "summary": "<short summary, ≤ 120 chars>"}`,
    "Where riskScore = 1 means 'highly risky to overwrite local' and 0 means 'safe overwrite'.",
    "Do not output anything except those N JSON lines.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

/** Strict parser: accepts a single line `{"riskScore": ..., "summary": "..."}`. */
export function parseBulkReviewVerdict(
  rawResponse: string,
  relPath: string,
): BulkReviewVerdict | null {
  const trimmed = rawResponse.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const risk = obj.riskScore;
  const summary = obj.summary;
  if (typeof risk !== "number" || !Number.isFinite(risk) || risk < 0 || risk > 1) return null;
  if (typeof summary !== "string" || summary.length > 240) return null;
  return { relPath, riskScore: risk, summary };
}

/** Reduce a list of verdicts into an overall recommendation. */
export interface BulkReviewSummary {
  averageRisk: number;
  maxRisk: number;
  high: BulkReviewVerdict[];
  medium: BulkReviewVerdict[];
  low: BulkReviewVerdict[];
  /** True if at least one file scored ≥ 0.7. Caller can show "review needed". */
  needsAttention: boolean;
}

export function summariseBulkReview(verdicts: BulkReviewVerdict[]): BulkReviewSummary {
  const high: BulkReviewVerdict[] = [];
  const medium: BulkReviewVerdict[] = [];
  const low: BulkReviewVerdict[] = [];
  let total = 0;
  let max = 0;
  for (const v of verdicts) {
    total += v.riskScore;
    if (v.riskScore > max) max = v.riskScore;
    if (v.riskScore >= 0.7) high.push(v);
    else if (v.riskScore >= 0.3) medium.push(v);
    else low.push(v);
  }
  return {
    averageRisk: verdicts.length === 0 ? 0 : total / verdicts.length,
    maxRisk: max,
    high,
    medium,
    low,
    needsAttention: high.length > 0,
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...\n[truncated, ${String(s.length - max)} more chars]`;
}
