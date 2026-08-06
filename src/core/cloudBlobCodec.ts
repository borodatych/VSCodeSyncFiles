/**
 * The wire form of a tracked file, in one place.
 *
 * Upload is `plaintext -> [gzip] -> [encrypt] -> upload`; reading it back has to
 * run the exact inverse, `decrypt -> gunzip`. That inverse was open-coded in six
 * places and simply missing in four more: those hashed the downloaded body as-is
 * and compared it against `_meta.hash`, which is always the *plaintext*
 * canonical hash. With encryption or compression enabled the two could never
 * match, so affected files were reported as conflicting forever, and the raw
 * wire bytes were also fed to the line-ending comparison as if they were content.
 *
 * Pure: no `vscode`, no I/O, no engine state. The engine passes its optional
 * `encrypt`/`decrypt` through.
 */
import { gunzipToPlaintext, gzipIfShrinks, plaintextLooksCompressible } from "./wireCompression.js";

export interface CloudBlobCodecOptions {
  /** Applied last on the way out, first on the way in. */
  encrypt?: (buf: Buffer) => Buffer;
  /** Must be the inverse of `encrypt`. */
  decrypt?: (buf: Buffer) => Buffer;
}

/** Wire bytes -> plaintext. `wireGzip` comes from the `_meta` row. */
export function decodeCloudBlob(
  body: Buffer,
  wireGzip: boolean,
  opts: CloudBlobCodecOptions,
): Buffer {
  const decrypted = opts.decrypt ? opts.decrypt(body) : body;
  return wireGzip ? gunzipToPlaintext(decrypted) : decrypted;
}

export interface EncodedCloudBlob {
  /** Bytes to upload. */
  body: Buffer;
  /** Whether the payload was gzipped — recorded in `_meta` as `wireGzip`. */
  wireGzip: boolean;
}

/**
 * Plaintext -> wire bytes. Compression is attempted only when the file looks
 * compressible and only kept when it actually shrinks the payload.
 */
export function encodeCloudBlob(
  plaintext: Buffer,
  posixRel: string,
  opts: CloudBlobCodecOptions & { compressUploads?: boolean },
): EncodedCloudBlob {
  let payload = plaintext;
  let wireGzip = false;
  if (opts.compressUploads === true && plaintextLooksCompressible(posixRel, plaintext)) {
    const gz = gzipIfShrinks(plaintext);
    if (gz !== undefined) {
      payload = gz;
      wireGzip = true;
    }
  }
  return {
    body: opts.encrypt ? opts.encrypt(payload) : payload,
    wireGzip,
  };
}
