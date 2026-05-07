import { hashCanonicalBuffer, type HashConfig } from "../utils/hash.js";

/** True when CRLF vs LF (or other) differ in `preserve` hash but LF-normalized content matches. */
export function preserveConflictSharesLfCanonical(
  localBuf: Buffer,
  cloudBuf: Buffer,
  relPath: string,
  hashCfg: HashConfig,
): boolean {
  const lfOnly: HashConfig = { ...hashCfg, lineEnding: "lf", onTextEncodingIssue: undefined };
  return hashCanonicalBuffer(localBuf, relPath, lfOnly) === hashCanonicalBuffer(cloudBuf, relPath, lfOnly);
}
