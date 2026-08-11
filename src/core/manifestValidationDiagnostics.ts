/**
 * Cross-cutting — pure diagnostic formatter on top of `manifestValidate.ts`.
 *
 * `manifestValidate` returns a single `{ ok: false; reason }` string for the
 * first violation encountered; that's enough for pre-flight gating but
 * doesn't help the UI surface multi-issue reports. This module wraps the
 * validator into a richer multi-issue diagnostic shape (path / kind /
 * severity) so the OutputChannel + corrupt-manifest repair flow can
 * present actionable output.
 *
 * No `vscode` import. The pure validator stays in
 * `manifestValidate.ts`; this module is structurally complementary.
 */

import { validateManifestShape } from "./manifestValidate.js";
import type { CloudManifest } from "./cloudLayout.js";

export type ManifestDiagnosticKind =
  | "shape_invalid"
  | "duplicate_file_path"
  | "machine_not_in_machines_array"
  | "tag_with_whitespace"
  | "addedAt_not_iso"
  /** Link Bindings: two LIVE rows share one identity (bind-vs-rename race). */
  | "duplicate_link_id";

export type ManifestDiagnosticSeverity = "error" | "warning" | "info";

export interface ManifestDiagnostic {
  kind: ManifestDiagnosticKind;
  severity: ManifestDiagnosticSeverity;
  detail: string;
  /** When applicable — the relPath / machineId / tag the issue lands on. */
  ref?: string;
}

export interface ManifestDiagnosticsReport {
  diagnostics: ManifestDiagnostic[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
  /** True iff `errorCount === 0`. Manifest can still be uploaded; warnings
   * are surfaced to the user but not blocking. */
  publishable: boolean;
}

const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export function diagnoseManifest(manifest: unknown): ManifestDiagnosticsReport {
  const diagnostics: ManifestDiagnostic[] = [];

  const shape = validateManifestShape(manifest);
  if (!shape.ok) {
    diagnostics.push({
      kind: "shape_invalid",
      severity: "error",
      detail: shape.reason,
    });
    return finalize(diagnostics);
  }

  const m = manifest as CloudManifest;

  // Duplicate file paths.
  const seenPaths = new Set<string>();
  for (const f of m.files) {
    if (seenPaths.has(f.path)) {
      diagnostics.push({
        kind: "duplicate_file_path",
        severity: "error",
        detail: `Manifest contains two entries for "${f.path}".`,
        ref: f.path,
      });
    } else {
      seenPaths.add(f.path);
      if (!ISO_LIKE_RE.test(f.addedAt)) {
        diagnostics.push({
          kind: "addedAt_not_iso",
          severity: "warning",
          detail: `File "${f.path}".addedAt is not an ISO-8601 timestamp ("${f.addedAt}").`,
          ref: f.path,
        });
      }
    }
  }

  // Link Bindings: one linkId on two LIVE rows — the artefact of a bind
  // racing a canonical rename. Tombstoned carriers are fine (that's how a
  // rename hands identity over); repair is `repairDuplicateLinkIds`.
  const liveByLinkId = new Map<string, string>();
  for (const f of m.files) {
    if (f.removedAt !== undefined || f.linkId === undefined) continue;
    const prior = liveByLinkId.get(f.linkId);
    if (prior !== undefined) {
      diagnostics.push({
        kind: "duplicate_link_id",
        severity: "warning",
        detail: `Rows "${prior}" and "${f.path}" share linkId ${f.linkId} — likely a bind/rename race.`,
        ref: f.path,
      });
    } else {
      liveByLinkId.set(f.linkId, f.path);
    }
  }

  // Tag-with-whitespace check (warning — UI listing trims, but stored
  // representation should be canonicalised).
  for (const t of m.tags) {
    if (t !== t.trim() || t.length === 0) {
      diagnostics.push({
        kind: "tag_with_whitespace",
        severity: "warning",
        detail: `Tag "${t}" has surrounding whitespace or is empty — UI may render inconsistently.`,
        ref: t,
      });
    }
  }

  // File entries reference machineIds (via `editingBy`) that are not in
  // `machines[]` — surface as info (not a failure) since manifests
  // routinely lag.
  const machineIds = new Set(m.machines.map((entry) => entry.machineId));
  for (const f of m.files) {
    if (f.editingBy !== undefined && !machineIds.has(f.editingBy)) {
      diagnostics.push({
        kind: "machine_not_in_machines_array",
        severity: "info",
        detail: `File "${f.path}".editingBy = "${f.editingBy}" which is not in the machines[] roster.`,
        ref: f.path,
      });
    }
  }

  return finalize(diagnostics);
}

function finalize(diagnostics: ManifestDiagnostic[]): ManifestDiagnosticsReport {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errorCount += 1;
    else if (d.severity === "warning") warningCount += 1;
    else infoCount += 1;
  }
  return {
    diagnostics,
    errorCount,
    warningCount,
    infoCount,
    publishable: errorCount === 0,
  };
}

/** Render a diagnostic report as plain text suitable for an OutputChannel.
 * Pure — no `console.log`, returns a string. */
export function formatManifestDiagnostics(report: ManifestDiagnosticsReport): string {
  if (report.diagnostics.length === 0) {
    return "Manifest OK — no diagnostics.";
  }
  const header = `Manifest diagnostics: ${String(report.errorCount)} errors, ${String(report.warningCount)} warnings, ${String(report.infoCount)} info`;
  const lines = report.diagnostics.map((d) => {
    const tag = d.severity.toUpperCase().padEnd(7);
    const ref = d.ref !== undefined ? ` [${d.ref}]` : "";
    return `${tag}${ref} ${d.detail}`;
  });
  return [header, ...lines].join("\n");
}
