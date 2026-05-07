export type LineEndingMode = "lf" | "crlf" | "preserve";

export function normalizeLineEndings(content: string, mode: LineEndingMode): string {
  if (mode === "preserve") {
    return content;
  }
  const withLf = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (mode === "crlf") {
    return withLf.replace(/\n/g, "\r\n");
  }
  return withLf;
}
