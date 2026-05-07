/** Wire-side gzip helpers (canonical plaintext in/out vs cloud blob `.gz`). */

import * as zlib from "node:zlib";
import { isProbablyBinaryPath, bufferLooksBinary } from "../utils/binary.js";
import { trackedFileCloudPath } from "./cloudLayout.js";

export const GZIP_BLOB_SUFFIX = ".gz";

export function blobCloudPath(workspaceId: string, posixRel: string, wireGzip: boolean): string {
  const base = trackedFileCloudPath(workspaceId, posixRel);
  return wireGzip ? `${base}${GZIP_BLOB_SUFFIX}` : base;
}

export function plaintextLooksCompressible(posixRel: string, plaintext: Buffer): boolean {
  if (isProbablyBinaryPath(posixRel)) {
    return false;
  }
  return !bufferLooksBinary(plaintext);
}

/** Returns gzip buffer if noticeably smaller than input; otherwise `undefined`. */
export function gzipIfShrinks(plaintext: Buffer): Buffer | undefined {
  const gz = zlib.gzipSync(plaintext);
  if (gz.length + 24 >= plaintext.length) {
    return undefined;
  }
  return gz;
}

export function gunzipToPlaintext(wireBody: Buffer): Buffer {
  return zlib.gunzipSync(wireBody);
}
