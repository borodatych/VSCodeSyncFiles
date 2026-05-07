export type LineEndingMode = "lf" | "crlf" | "preserve";

// Single-pass: collapse CRLF, lone CR, or LF — whichever appears — into LF.
// Then optionally re-emit as CRLF.
const ANY_LINE_BREAK = /\r\n|\r|\n/g;

export function normalizeLineEndings(content: string, mode: LineEndingMode): string {
  if (mode === "preserve") {
    return content;
  }
  const withLf = content.replace(ANY_LINE_BREAK, "\n");
  return mode === "crlf" ? withLf.replace(/\n/g, "\r\n") : withLf;
}
