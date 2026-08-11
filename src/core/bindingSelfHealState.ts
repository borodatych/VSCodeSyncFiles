/**
 * Session-scoped rate limit for the binding self-heal (docs/v2/linkBindings.md,
 * stage 3): at most one healing manifest PUT per workspace per session —
 * two machines with divergent local state must not ping-pong healing writes.
 * Module-level on purpose: engines are constructed per operation, so instance
 * state cannot carry the "already healed" fact across passes.
 */
const healedThisSession = new Set<string>();

export function shouldAttemptBindingSelfHeal(workspaceRoot: string, workspaceId: string): boolean {
  const key = `${workspaceRoot}\u0000${workspaceId}`;
  if (healedThisSession.has(key)) {
    return false;
  }
  healedThisSession.add(key);
  return true;
}

/** Test seam. */
export function resetBindingSelfHealState(): void {
  healedThisSession.clear();
}
