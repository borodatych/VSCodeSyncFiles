import { SyncEngine } from "../../src/core/syncEngine.js";
import type { ICloudProvider } from "../../src/providers/cloudProviderTypes.js";
import type { LineEndingMode } from "../../src/utils/normalize.js";

const MB = 1024 * 1024;

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
  const deltaRaw = process.env.VSCODESYNC_DELTA_SYNC?.trim();
  const deltaSync = deltaRaw === "1" || deltaRaw?.toLowerCase() === "true";
  const thRaw = process.env.VSCODESYNC_DELTA_THRESHOLD_KB?.trim();
  const deltaThresholdKB =
    thRaw !== undefined && thRaw !== "" && Number.isFinite(Number(thRaw)) && Number(thRaw) > 0
      ? Number(thRaw)
      : 100;
  return new SyncEngine({
    workspaceRoot,
    provider,
    machineId,
    machineName,
    maxFileSizeBytes: maxB > 0 ? maxB : undefined,
    lineEnding,
    encodingLint: true,
    localBackupEnabled: true,
    localBackupRetentionDays: 7,
    compressUploads: false,
    requireMachineApproval: () => false,
    deltaSync,
    deltaThresholdKB,
  });
}
