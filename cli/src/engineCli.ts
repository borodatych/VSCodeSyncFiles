import { SyncEngine } from "../../src/core/syncEngine.js";
import { decryptBuffer, encryptBuffer } from "../../src/core/encryption.js";
import type { ICloudProvider } from "../../src/providers/cloudProviderTypes.js";
import type { LineEndingMode } from "../../src/utils/normalize.js";

const MB = 1024 * 1024;

/**
 * Encryption for the CLI.
 *
 * The CLI used to construct `SyncEngine` with no `encrypt`/`decrypt` at all, so
 * `vscodesync pull` against an encrypted workspace overwrote working files with
 * ciphertext without a single question. The CLI cannot reach VS Code's
 * SecretStorage, so the key has to be supplied explicitly:
 *
 *   VSCODESYNC_ENCRYPTION=1
 *   VSCODESYNC_ENCRYPTION_KEY=<base64 of the same key the extension uses>
 *
 * Declaring encryption without a key is not silently ignored: the engine
 * refuses every blob operation, which is the only safe outcome.
 */
function readEncryptionFromEnv(): { required: boolean; key: Buffer | null } {
  const flag = process.env.VSCODESYNC_ENCRYPTION?.trim().toLowerCase();
  const required = flag === "1" || flag === "true" || flag === "yes";
  const raw = process.env.VSCODESYNC_ENCRYPTION_KEY?.trim();
  if (raw === undefined || raw.length === 0) {
    return { required, key: null };
  }
  const key = Buffer.from(raw, "base64");
  // A truncated or mistyped key would decrypt to garbage and be written to
  // disk, so an implausible length is rejected up front.
  if (key.length !== 32) {
    throw new Error(
      `VSCODESYNC_ENCRYPTION_KEY: ожидается 32 байта в base64, получено ${String(key.length)}`,
    );
  }
  return { required: true, key };
}

export function createCliSyncEngine(
  workspaceRoot: string,
  provider: ICloudProvider,
  machineId: string,
  machineName: string,
): SyncEngine {
  const raw = process.env.VSCODESYNC_MAX_FILE_MB?.trim();
  const maxMb = raw !== undefined && raw !== "" ? Number(raw) : 5;
  const maxB = Number.isFinite(maxMb) && maxMb >= 0 ? maxMb * MB : 5 * MB;
  const lineEnding: LineEndingMode = "lf";
  const encryption = readEncryptionFromEnv();
  const encKey = encryption.key;
  return new SyncEngine({
    workspaceRoot,
    provider,
    machineId,
    machineName,
    // Every CLI invocation is someone typing a command. There is no background
    // scheduler in the CLI, so nothing here may be "auto".
    trigger: "user",
    maxFileSizeBytes: maxB > 0 ? maxB : undefined,
    lineEnding,
    encodingLint: true,
    localBackupEnabled: true,
    localBackupRetentionDays: 7,
    compressUploads: false,
    encryptionRequired: encryption.required,
    encrypt: encKey !== null ? (buf: Buffer): Buffer => encryptBuffer(encKey, buf) : undefined,
    decrypt: encKey !== null ? (buf: Buffer): Buffer => decryptBuffer(encKey, buf) : undefined,
    requireMachineApproval: () => false,
  });
}
