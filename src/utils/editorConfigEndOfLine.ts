import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LineEndingMode } from "./normalize.js";

/**
 * Reads `.editorconfig` in workspace root for a typical `end_of_line = lf|crlf|cr` hint (first match).
 */
export async function readEditorConfigSuggestedLineEnding(workspaceRoot: string): Promise<LineEndingMode | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, ".editorconfig"), "utf8");
    const m = /\bend_of_line\s*=\s*(lf|crlf|cr)\b/im.exec(raw);
    if (!m) {
      return null;
    }
    const v = m[1].toLowerCase();
    if (v === "crlf") {
      return "crlf";
    }
    if (v === "lf" || v === "cr") {
      return "lf";
    }
    return null;
  } catch {
    return null;
  }
}
