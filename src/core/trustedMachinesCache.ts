/**
 * The set of machine ids the user marked as trusted, held in one module-level
 * cache instead of on `globalThis` (F7).
 *
 * The engine consults this on a hot path, so a cache is warranted; hanging it
 * off `globalThis` under a `__vscodesync…` key was not. Nothing else in the
 * process could see who owned it, the type was re-declared at both ends, and a
 * second copy of the extension in the same host would have shared it silently.
 *
 * The UI layer owns the persistence (VS Code `globalState`); this module owns
 * only the in-memory answer.
 */

let trustedIds: ReadonlySet<string> = new Set<string>();

/** Replace the cache. Called by the UI whenever the registry changes. */
export function setTrustedMachineIds(ids: Iterable<string>): void {
  trustedIds = new Set(ids);
}

export function isTrustedMachineId(machineId: string): boolean {
  return trustedIds.has(machineId);
}

/** Test seam. */
export function clearTrustedMachineIds(): void {
  trustedIds = new Set<string>();
}
