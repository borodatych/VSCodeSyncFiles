/**
 * What to upload and where, decided without touching the network.
 *
 * `encodeCloudBlob` already owns the byte pipeline (gzip → encrypt); the part
 * that kept being re-derived next to it is the cloud path, which depends on
 * whether compression actually kicked in — `blobCloudPath` appends `.gz`. Both
 * upload sites paired those two calls by hand, and an earlier bug in exactly
 * this pairing (path computed without the suffix) is why compressed blobs used
 * to point at nothing.
 *
 * Pure: buffer in, plan out.
 */
import { encodeCloudBlob, type CloudBlobCodecOptions } from "../cloudBlobCodec.js";
import { blobCloudPath } from "../wireCompression.js";

export interface UploadEncodingInput extends CloudBlobCodecOptions {
  workspaceId: string;
  posixRel: string;
  plaintext: Buffer;
  compressUploads?: boolean;
}

export interface PlannedUploadEncoding {
  /** Bytes to send. */
  body: Buffer;
  /** Recorded in `_meta` as `wireGzip`; the reader needs it to gunzip. */
  wireGzip: boolean;
  /** Where the bytes go — carries the `.gz` suffix when `wireGzip`. */
  cloudPath: string;
}

export function planUploadEncoding(input: UploadEncodingInput): PlannedUploadEncoding {
  const encoded = encodeCloudBlob(input.plaintext, input.posixRel, {
    encrypt: input.encrypt,
    decrypt: input.decrypt,
    compressUploads: input.compressUploads,
  });
  return {
    body: encoded.body,
    wireGzip: encoded.wireGzip,
    cloudPath: blobCloudPath(input.workspaceId, input.posixRel, encoded.wireGzip),
  };
}
