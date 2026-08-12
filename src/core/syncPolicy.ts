/**
 * The single mutation checkpoint (audit finding F2).
 *
 * The product invariant for 1.0.0 is "nothing without asking": a background
 * source may compute divergence, but it may never move a byte. Before this
 * module the invariant was enforced nowhere in particular and bypassed in
 * several places at once — `gitBranchAutoSync` pushed and pulled regardless of
 * `autoSyncMode`, the offline and schedule flushes carried explicit
 * `bypassSchedule` / `bypassAutoPause` / `bypassRateLimit` parameters, and a
 * `vscodesync` task with `runOn: folderOpen` reached `pushAll` with no gate at
 * all. A policy that can be switched off by an argument is not a policy.
 *
 * So the decision lives here, as a pure function of the operation and the
 * trigger, and the engine imports it directly instead of receiving it through
 * `SyncEngineDeps`. That is deliberate: an injected policy would immediately
 * become the next bypass parameter. Nothing about this decision is
 * configurable, and nothing can override it.
 *
 * The trigger itself is a *required* field of `SyncEngineDeps`. The lesson is
 * `encKey`: it was an optional fifth argument of `makeEngine` and 17 of the 24
 * construction sites simply never passed it, so encryption silently switched
 * itself off. An optional trigger defaulting to "user" would fail the same way
 * and in the same direction — permissively. Required means the compiler asks
 * every construction site the question.
 *
 * Pure: no `vscode`, no I/O, no engine state.
 */

/** Who asked for the operation. */
export type SyncTrigger =
  /** A human acted: palette command, menu item, button, wizard step. */
  | "user"
  /** Anything else: timer, editor event, webhook, activation, queue flush, branch switch. */
  | "auto";

/**
 * Engine entry points that move data or change what is tracked.
 *
 * This union is the single source of truth for the checkpoint: the engine
 * gates exactly these methods, and `tests/unit/mutationPolicyGate.test.ts`
 * verifies that each of them really does start with an `assertMayMutate` call.
 * Adding a mutating method without adding it here fails the gate.
 *
 * Deliberately absent, though they do write:
 *
 * - `setWorkspaceSyncState` — patches `syncState` in the local config and
 *   nothing else. A git branch switch must keep suspending and activating
 *   workspaces automatically; that is state about *whether* to sync, not a
 *   sync.
 * - `adoptManifestFilesFromCloud`, `pruneTrackingFromManifest` — private, and
 *   reachable only from `applyTrackingFromCloud` and the user half of
 *   `syncWorkspace`, both of which are gated. The detector reports the drift
 *   through `onTrackingDriftDetected` instead of applying it.
 * - `downloadManifest`, `pullMeta` and the read APIs built on them — they
 *   refresh cached etags, tags and the machine list in the local config. Cache
 *   maintenance, not user data.
 */
export const MUTATION_OPS = [
  // --- Moving file bytes -----------------------------------------------
  "pushFile",
  "pullFile",
  "pushAll",
  "pullAll",
  "syncOneFile",
  "syncWorkspace",
  "forcePullWorkspace",
  "applyTrackingFromCloud",
  // --- Writing cloud metadata ------------------------------------------
  "putManifest",
  "pushMetaJson",
  // --- Workspace lifecycle ---------------------------------------------
  "createWorkspace",
  "attachCloudWorkspace",
  "detachWorkspaceLocal",
  "deleteWorkspaceFromCloud",
  "deleteCloudFilesOnly",
  "restoreWorkspaceLocal",
  "repushWorkspaceToCloud",
  "mergeWorkspaces",
  "renameWorkspaceNote",
  "setWorkspaceGitBranch",
  "setWorkspaceTags",
  "setWorkspaceSharedIgnorePatterns",
  "setMachineManifestStatus",
  // --- Tracking composition --------------------------------------------
  "addFiles",
  "removeTrackedFiles",
  "untrackFileLocal",
  "untrackFileTombstoneOnly",
  "renameTrackedFile",
  "renameCanonicalKeys",
  "bindLocalFile",
  "bindLocalFolder",
  "renameLinkName",
  "setWorkspaceSyncScopes",
  // --- Conflict resolution ---------------------------------------------
  "resolveConflictKeepMine",
  "resolveConflictTakeTheirs",
  "resolveConflictKeepBoth",
  // --- Repair and maintenance ------------------------------------------
  "repairByCloudScan",
  "repairLocalStateFromCloud",
  "applyHashBlake3Backfill",
  "clearStaleManifestEditingLocks",
  // --- Locks and history -----------------------------------------------
  "setSoftLock",
  "clearSoftLock",
  "runDeferredHistorySnapshots",
] as const;

/**
 * A runtime list rather than a bare union, so the gate can walk it. A type-only
 * union would have to be recovered by parsing this file's text, and a
 * source-text parser is exactly the kind of check that silently stops matching
 * after an unrelated reformat.
 */
export type MutationOp = (typeof MUTATION_OPS)[number];

export type MutationDecision = "allow" | "deny";

/**
 * The whole policy. Automatic sources observe; they do not act.
 *
 * Deliberately not parameterised by settings: `autoSyncMode`, pause, quiet
 * hours and rate limits decide whether the *detector* runs, which is a
 * different question asked earlier and elsewhere. Once an automatic source has
 * reached a mutating engine method, the answer is always no.
 */
export function mutationPolicy(_op: MutationOp, trigger: SyncTrigger): MutationDecision {
  return trigger === "user" ? "allow" : "deny";
}

/**
 * Refusal raised by the checkpoint.
 *
 * Carries the operation and the trigger so the Output channel can name what
 * was refused. It is not an error in the user's sense — a background path being
 * turned away is the extension working correctly — so callers log it and never
 * raise an error dialog for it.
 */
export class MutationDeniedError extends Error {
  constructor(
    readonly op: MutationOp,
    readonly trigger: SyncTrigger,
  ) {
    super(
      `VSCodeSync: операция «${op}» отклонена — автоматические источники не изменяют файлы. ` +
        "Откройте панель «Расхождения» и подтвердите действие.",
    );
    this.name = "MutationDeniedError";
  }
}

/** Throwing form used as the first statement of every gated engine method. */
export function assertMutationAllowed(op: MutationOp, trigger: SyncTrigger): void {
  if (mutationPolicy(op, trigger) === "deny") {
    throw new MutationDeniedError(op, trigger);
  }
}
