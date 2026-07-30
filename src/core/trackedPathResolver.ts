/**
 * The one way to convert between an absolute file path and a tracked posix path.
 *
 * `pathMapping` lets a machine keep synced files in a subdirectory of the
 * workspace folder rather than at its root. Two helpers in `pathMapping.ts`
 * implement that correctly, but roughly two dozen call sites did the conversion
 * by hand — `path.join(root, ...rel.split("/"))` and
 * `path.relative(root, abs)` — which silently ignores the mapping. With a
 * mapping configured those sites compute a path that does not exist, so a file
 * that *is* tracked is reported as "not in sync", its decoration disappears,
 * and commands acting on it do nothing.
 *
 * Both directions return `undefined` rather than throwing when the path falls
 * outside the sync root: for nearly every caller that means "not a tracked
 * file", not an error.
 *
 * The machine name comes from global config, which needs `SecretStorage` and so
 * cannot be constructed here; activation injects a provider once.
 */
import {
  absoluteToTrackedPosix,
  trackedLocalAbsolutePath,
} from "./pathMapping.js";
import { WorkspaceConfigManager } from "./workspaceConfigManager.js";

type MachineNameProvider = () => Promise<string>;

let machineNameProvider: MachineNameProvider | undefined;

/** Called once during activation. Without it the resolver falls back to "". */
export function setTrackedPathMachineNameProvider(fn: MachineNameProvider): void {
  machineNameProvider = fn;
}

/** Test seam. */
export function resetTrackedPathMachineNameProvider(): void {
  machineNameProvider = undefined;
}

async function machineName(): Promise<string> {
  if (!machineNameProvider) return "";
  try {
    return await machineNameProvider();
  } catch {
    return "";
  }
}

/**
 * Absolute path → tracked posix path, honouring `pathMapping`.
 * `undefined` when the file lies outside this workspace's sync root.
 */
export async function trackedPosixRelFor(
  workspaceRoot: string,
  absoluteFsPath: string,
): Promise<string | undefined> {
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  try {
    return absoluteToTrackedPosix(workspaceRoot, cfg.pathMapping, await machineName(), absoluteFsPath);
  } catch {
    return undefined;
  }
}

/**
 * Tracked posix path → absolute path, honouring `pathMapping`.
 * `undefined` when the result would escape the workspace folder.
 */
export async function trackedAbsolutePathFor(
  workspaceRoot: string,
  posixRel: string,
): Promise<string | undefined> {
  const cfg = await WorkspaceConfigManager.load(workspaceRoot);
  try {
    return trackedLocalAbsolutePath(workspaceRoot, cfg.pathMapping, await machineName(), posixRel);
  } catch {
    return undefined;
  }
}
