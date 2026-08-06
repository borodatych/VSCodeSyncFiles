/**
 * Reading and writing a tracked file's bytes in the cloud.
 *
 * Extracted from `SyncEngine` (этап 5.2). The wire pipeline itself already
 * lives in `cloudBlobCodec`; what sat in the engine around it was the part that
 * needs a provider: decoding a download, verifying an upload landed, and
 * deleting a blob without caring whether it was already gone.
 *
 * The engine still owns *when* these run; this module owns *how*.
 */
import type { ICloudProvider } from "../../providers/cloudProviderTypes.js";
import { ProviderError } from "../../providers/cloudProviderTypes.js";
import { decodeCloudBlob } from "../cloudBlobCodec.js";
import { hashCanonicalBuffer, type HashConfig } from "../../utils/hash.js";
import { warnLog } from "../../utils/log.js";

export interface BlobTransferDeps {
  provider: ICloudProvider;
  decrypt?: (buf: Buffer) => Buffer;
  /** Canonicalisation config for the hash of a given path. */
  hashCfg: (posixRel: string) => HashConfig;
  /** How many times a post-upload verify may re-read before giving up. */
  verifyRetries: () => number;
}

export interface BlobTransfer {
  /** Wire bytes → plaintext (decrypt, then gunzip when `wireGzip`). */
  decode(body: Buffer, wireGzip: boolean): Buffer;
  /**
   * Re-read what was just uploaded and confirm its plaintext hash. Guards
   * against a provider that accepted the write and stored something else.
   */
  verifyUpload(
    cloudPath: string,
    expectedPlaintextHash: string,
    posixRel: string,
    wireGzip: boolean,
  ): Promise<void>;
  /** Delete, treating "already absent" as success. */
  deleteBestEffort(cloudPath: string): Promise<void>;
}

export function createBlobTransfer(deps: BlobTransferDeps): BlobTransfer {
  const decode = (body: Buffer, wireGzip: boolean): Buffer =>
    decodeCloudBlob(body, wireGzip, { decrypt: deps.decrypt });

  return {
    decode,

    async verifyUpload(cloudPath, expectedPlaintextHash, posixRel, wireGzip): Promise<void> {
      const retries = deps.verifyRetries();
      for (let i = 0; i < retries; i += 1) {
        const got = await deps.provider.downloadFile(cloudPath);
        const body = decode(got.body, wireGzip);
        if (hashCanonicalBuffer(body, posixRel, deps.hashCfg(posixRel)) === expectedPlaintextHash) {
          return;
        }
      }
      throw new Error("verifyUploadPlaintextHash: hash mismatch after retries");
    },

    async deleteBestEffort(cloudPath): Promise<void> {
      try {
        await deps.provider.deleteFile(cloudPath);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "NOT_FOUND") {
          return;
        }
        warnLog(
          "blobTransfer",
          `deleteBestEffort(${cloudPath}) suppressed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
