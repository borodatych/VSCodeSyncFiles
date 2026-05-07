/**
 * Second VS Code window on the same workspace folders: cloud writes disabled except
 * _meta updates that complete a pull (see `withPullCloudMetaWriteAllowed`).
 */

let secondaryReadOnly = false;
let pullCloudMetaWriteDepth = 0;

export function setSecondaryWorkspaceInstanceReadOnly(on: boolean): void {
  secondaryReadOnly = on;
}

export function isSecondaryWorkspaceInstanceReadOnly(): boolean {
  return secondaryReadOnly;
}

export function rejectIfSecondaryWorkspaceInstanceReadOnly(): void {
  if (secondaryReadOnly) {
    throw new Error(
      "VSCodeSync: это окно в режиме только чтения — запись в облако отключена (sync уже ведёт другое окно VSCode с тем же workspace). Pull по-прежнему доступен.",
    );
  }
}

/** Allows `pushMetaJson` while finishing `pullFile` on a secondary instance. */
export async function withPullCloudMetaWriteAllowed<T>(fn: () => Promise<T>): Promise<T> {
  pullCloudMetaWriteDepth += 1;
  try {
    return await fn();
  } finally {
    pullCloudMetaWriteDepth -= 1;
  }
}

export function isPullMetaCloudWriteActive(): boolean {
  return pullCloudMetaWriteDepth > 0;
}
