/**
 * v2.20.2 — `workspace.fs.prefetch` defensive adapter (skeleton).
 *
 * `vscode.workspace.fs.prefetch(uri)` is a *proposed* API behind an
 * `--enable-proposed-api` flag in Insiders / Cursor 1.95+. It tells virtual
 * filesystem providers to warm caches for a URI the user is likely to open
 * next. The pure planner that picks *which* URIs to warm lives in
 * `src/core/workspaceFsPrefetchHints.ts`.
 *
 * This adapter is the call-site:
 *   - Probes whether `prefetch` exists on the surface at runtime.
 *   - On hit: forwards the planner's `toPrefetch[]` results.
 *   - On miss: returns `{ ok: false, reason: "api_not_available" }` so the
 *     caller can no-op silently or log once per session.
 *
 * Imports only the `vscode` types — runtime call uses `as` casts because
 * the proposed API is not in `@types/vscode` for stable.
 */
import type * as vscode from "vscode";

export type PrefetchAdapterResult =
  | { ok: true; prefetched: number }
  | { ok: false; reason: "api_not_available" | "no_uris" | "error"; detail?: string };

export interface PrefetchSurface {
  readonly fs: {
    readonly prefetch?: (uri: vscode.Uri) => Promise<void>;
  };
}

export interface PrefetchInput {
  readonly uris: readonly vscode.Uri[];
}

export async function tryPrefetchUris(
  surface: PrefetchSurface,
  input: PrefetchInput,
): Promise<PrefetchAdapterResult> {
  if (input.uris.length === 0) return { ok: false, reason: "no_uris" };
  const prefetch = surface.fs.prefetch;
  if (typeof prefetch !== "function") {
    return { ok: false, reason: "api_not_available" };
  }
  try {
    await Promise.all(input.uris.map((u) => prefetch(u)));
    return { ok: true, prefetched: input.uris.length };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
