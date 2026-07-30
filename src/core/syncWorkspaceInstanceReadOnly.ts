/**
 * Second VS Code window on the same workspace folders: cloud writes disabled
 * except the `_meta` update that completes a pull. That exception used to be a
 * process-wide depth counter (`withPullCloudMetaWriteAllowed`): while any
 * parallel pull held it open, *any* other cloud `_meta` write in the process
 * passed the read-only check. It is now the `reason` argument of
 * `pushMetaJson` — scoped to the one call, impossible to leak (F7).
 */

let secondaryReadOnly = false;

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
