/**
 * v2.12.1 — `qrcode-terminal` rendering helper (pure adapter).
 *
 * The package `qrcode-terminal` (^0.12, in optionalDependencies) prints a
 * QR code as ANSI block characters into a writable stream. Inside VS Code
 * the natural sink is an `OutputChannel.appendLine` — but the lib expects
 * `process.stdout`-shaped writers, and an OutputChannel only exposes
 * `appendLine`.
 *
 * This module:
 *   - Lazy-loads the package via `require` (so missing optional dep doesn't
 *     break import); returns a typed sentinel result on missing/load fail.
 *   - Exposes `renderQrToLines(payload, opts?)` that returns the rendered
 *     string broken into lines — caller can `appendLine` each into any
 *     OutputChannel.
 *   - Pairs with `planQrChunks` (in `p2pQrExchange.ts`) for the multi-QR
 *     air-gapped flow: render each chunk as its own QR, prompt the user
 *     to scan, repeat until `total` chunks delivered.
 *
 * No `vscode` import.
 */

export type RenderQrResult =
  | { ok: true; lines: readonly string[] }
  | { ok: false; reason: "module_not_installed" | "module_load_failed"; error?: string };

export interface RenderQrOptions {
  /** ECC level — `qrcode-terminal` accepts `"L"` / `"M"` / `"Q"` / `"H"`.
   *  `"M"` (default) is the right balance for terminal rendering. */
  readonly level?: "L" | "M" | "Q" | "H";
  /** When true, render with half-height blocks for tighter output. */
  readonly small?: boolean;
  /** Test seam for the lazy-loader. */
  readonly loader?: () => unknown;
}

interface QrcodeTerminalLib {
  generate: (
    text: string,
    opts: { small?: boolean },
    callback: (rendered: string) => void,
  ) => void;
  setErrorLevel: (lvl: "L" | "M" | "Q" | "H") => void;
}

function defaultLoader(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("qrcode-terminal") as unknown;
}

function isLib(x: unknown): x is QrcodeTerminalLib {
  if (x === null || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.generate === "function" && typeof obj.setErrorLevel === "function";
}

export function renderQrToLines(
  payload: string,
  opts: RenderQrOptions = {},
): RenderQrResult {
  let lib: unknown;
  try {
    lib = (opts.loader ?? defaultLoader)();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/cannot find module|MODULE_NOT_FOUND/i.test(msg)) {
      return { ok: false, reason: "module_not_installed", error: msg };
    }
    return { ok: false, reason: "module_load_failed", error: msg };
  }
  if (!isLib(lib)) {
    return { ok: false, reason: "module_load_failed", error: "qrcode-terminal export shape unexpected" };
  }
  if (opts.level !== undefined) lib.setErrorLevel(opts.level);
  let rendered = "";
  lib.generate(payload, { small: opts.small ?? true }, (s) => { rendered = s; });
  if (rendered.length === 0) {
    return { ok: false, reason: "module_load_failed", error: "qrcode-terminal returned empty rendering" };
  }
  // qrcode-terminal output ends with trailing newline; trim and split.
  const lines = rendered.replace(/\n+$/u, "").split("\n");
  return { ok: true, lines };
}

/**
 * Helper for the multi-chunk QR flow. Given a list of chunk payloads (from
 * `planQrChunks`), produces the rendered ASCII-art lines for each, prefixed
 * with a `[i/N] sessionId` header line so the human reader can keep track.
 */
export interface RenderChunkInput {
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly sessionId: string;
  readonly chunkLine: string;
}

export function renderChunkBlock(
  input: RenderChunkInput,
  opts: RenderQrOptions = {},
): RenderQrResult {
  const r = renderQrToLines(input.chunkLine, opts);
  if (!r.ok) return r;
  const header = `[${String(input.chunkIndex + 1)}/${String(input.totalChunks)}] sessionId=${input.sessionId}`;
  return { ok: true, lines: [header, ...r.lines] };
}
