/**
 * SSE wire-format parser for smee.io payloads — vscode-free so it's covered
 * by unit tests. Used by `webhookTunnel.ts` which adds the network and
 * UI side-effects on top.
 *
 * smee.io sends one Server-Sent-Event per delivered HTTP request. The body of
 * that event is JSON: `{ "body": <object>, "<header>": "<value>", … }`.
 * Top-level fields other than `body` whose value is a string become headers
 * passed to the local handler.
 */

export interface SmeePayload {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * Parse a single SSE message block (the chunk between `\n\n` delimiters in
 * the SSE stream) and call `handler` if the block carries a useful payload.
 * Heartbeat / connect-ack / malformed JSON are silently ignored.
 */
export function parseSmeeSseBlock(
  sseBlock: string,
  handler: (payload: SmeePayload) => void,
): void {
  let data = "";
  for (const line of sseBlock.split("\n")) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }
  if (!data || data === "connected") {
    return;
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const body = (parsed.body as Record<string, unknown> | undefined) ?? parsed;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== "body" && typeof v === "string") {
        headers[k] = v;
      }
    }
    handler({ body, headers });
  } catch {
    /* malformed JSON from smee.io — skip */
  }
}
