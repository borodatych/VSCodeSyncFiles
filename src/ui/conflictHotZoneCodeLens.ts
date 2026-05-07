/**
 * CodeLens that highlights conflict hot-zones on the file currently open in
 * the editor. Layout / clamping live in the pure planner; this module is the
 * thin VS Code adapter.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { getHotZones } from "./conflictHeatmapStoreFs.js";
import {
  formatHotZoneLensTitle,
  planHotZoneLenses,
  type HotZoneLensPlan,
} from "./conflictHotZoneLensPlanner.js";

const CACHE_TTL_MS = 30_000;

export interface ConflictHotZoneCodeLensDeps {
  storageDir: string;
  /** Map workspace-anchor URI → relative POSIX path used by the heatmap store. */
  toRelPath(uri: vscode.Uri): string | null;
}

export class ConflictHotZoneCodeLensProvider
  implements vscode.CodeLensProvider, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private cache: { at: number; plansByPath: Map<string, HotZoneLensPlan[]> } = {
    at: 0,
    plansByPath: new Map(),
  };

  constructor(private readonly deps: ConflictHotZoneCodeLensDeps) {}

  refresh(): void {
    this.cache = { at: 0, plansByPath: new Map() };
    this.emitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const enabled = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("conflictHotZoneCodeLens.enabled", true);
    if (!enabled) return [];
    const rel = this.deps.toRelPath(document.uri);
    if (!rel) return [];
    const plans = await this.plansFor(rel, document.lineCount);
    if (plans.length === 0) return [];
    return plans.map((p) => {
      const range = new vscode.Range(p.line, 0, p.line, 0);
      return new vscode.CodeLens(range, {
        title: formatHotZoneLensTitle(p),
        command: "vscodesync.showConflictHeatmap",
      });
    });
  }

  private async plansFor(rel: string, lineCount: number): Promise<HotZoneLensPlan[]> {
    if (Date.now() - this.cache.at > CACHE_TTL_MS) {
      this.cache.plansByPath = new Map();
      try {
        const zones = await getHotZones(this.deps.storageDir, 1);
        // Bucket plans per relPath so the next document hit avoids re-reading.
        for (const z of zones) {
          const arr = this.cache.plansByPath.get(z.relPath) ?? [];
          arr.push({
            line: 0,
            zoneStart: z.startLine,
            zoneEnd: z.endLine,
            count: z.count,
          });
          this.cache.plansByPath.set(z.relPath, arr);
        }
        this.cache.at = Date.now();
      } catch {
        // Best-effort: return cached or empty.
        return [];
      }
    }
    const cachedZones = this.cache.plansByPath.get(rel);
    if (!cachedZones || cachedZones.length === 0) return [];
    // Re-run the pure planner for this document so clamping applies to the
    // current line count.
    return planHotZoneLenses(
      cachedZones.map((p) => ({
        relPath: rel,
        startLine: p.zoneStart,
        endLine: p.zoneEnd,
        count: p.count,
      })),
      rel,
      lineCount,
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Map a vscode.Uri to a workspace-relative POSIX path; null if not in a workspace. */
export function makeToRelPath(): (uri: vscode.Uri) => string | null {
  return (uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return null;
    const rel = path.relative(folder.uri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith("..")) return null;
    return rel.split(path.sep).join("/");
  };
}
