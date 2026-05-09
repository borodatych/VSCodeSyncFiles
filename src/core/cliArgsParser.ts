/**
 * v2.20.1 — pure CLI argument parser for the planned `vscodesync` bin.
 * **Skeleton.** No `process.argv` access, no `fs`. Caller passes the
 * argv tail (everything past the bin name) and gets back a discriminated
 * union the dispatch table can switch on.
 *
 * Subcommands the parser knows about:
 *
 *     vscodesync status
 *     vscodesync push  [workspaceId]
 *     vscodesync pull  [workspaceId]
 *     vscodesync sign-in --device-code
 *     vscodesync help [command]
 *
 * Unknown commands collapse to `{ kind: "help", failedCommand?: string }`
 * so the CLI never silently does the wrong thing.
 */

export type CliCommand =
  | { kind: "status" }
  | { kind: "push"; workspaceId?: string }
  | { kind: "pull"; workspaceId?: string }
  | { kind: "sign-in"; useDeviceCode: boolean }
  | { kind: "help"; failedCommand?: string };

export interface ParseCliArgsResult {
  command: CliCommand;
  /** True when the user explicitly asked for `--help`. */
  helpRequested: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  if (argv.length === 0) {
    return { command: { kind: "help" }, helpRequested: false };
  }
  const head = argv[0];
  const rest = argv.slice(1);
  if (head === "--help" || head === "-h") {
    return { command: { kind: "help" }, helpRequested: true };
  }

  switch (head) {
    case "status":
      return { command: { kind: "status" }, helpRequested: hasHelpFlag(rest) };
    case "push": {
      const wid = pickPositional(rest);
      const cmd: CliCommand = wid === undefined ? { kind: "push" } : { kind: "push", workspaceId: wid };
      return { command: cmd, helpRequested: hasHelpFlag(rest) };
    }
    case "pull": {
      const wid = pickPositional(rest);
      const cmd: CliCommand = wid === undefined ? { kind: "pull" } : { kind: "pull", workspaceId: wid };
      return { command: cmd, helpRequested: hasHelpFlag(rest) };
    }
    case "sign-in":
      return {
        command: { kind: "sign-in", useDeviceCode: rest.includes("--device-code") },
        helpRequested: hasHelpFlag(rest),
      };
    case "help":
      return {
        command: { kind: "help", failedCommand: pickPositional(rest) },
        helpRequested: true,
      };
    default:
      return {
        command: { kind: "help", failedCommand: head },
        helpRequested: false,
      };
  }
}

function pickPositional(rest: readonly string[]): string | undefined {
  for (const arg of rest) {
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

function hasHelpFlag(rest: readonly string[]): boolean {
  return rest.includes("--help") || rest.includes("-h");
}

export class CliNotImplementedError extends Error {
  readonly code = "cli_not_implemented" as const;
  constructor(command: string) {
    super(
      `vscodesync CLI command "${command}" is in skeleton mode (v2.20.1 in roadmap). ` +
      "The argv parser is wired; the dispatch table to engine + provider is the next iteration.",
    );
    this.name = "CliNotImplementedError";
  }
}
