/** Only http(s) without credentials — ingestion must not leak secrets via URL. */
export function isSafeTelemetryIngestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return false;
    }
    if (u.username !== "" || u.password !== "") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
