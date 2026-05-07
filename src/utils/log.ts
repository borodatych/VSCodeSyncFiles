/**
 * Lightweight diagnostic logger.
 *
 * Decoupled from `vscode`: the extension wires a VS Code OutputChannel sink at
 * activation; CLI / tests get a no-op default. Use {@link verboseLog} only for
 * non-essential traces (gated by the `vscodesync.notificationLevel` setting).
 */

export type LogLevel = "verbose" | "warn" | "error";

export interface LogSink {
  write(level: LogLevel, scope: string, parts: readonly unknown[]): void;
}

let sink: LogSink = {
  write(): void {
    /* no-op default for CLI / tests */
  },
};
let verboseEnabled = false;

export type CrashReporter = (scope: string, error: Error) => void;
let crashReporter: CrashReporter = () => {
  /* no-op default; opt-in via setCrashReporter when telemetry is enabled */
};

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function setVerboseEnabled(on: boolean): void {
  verboseEnabled = on;
}

export function isVerboseEnabled(): boolean {
  return verboseEnabled;
}

export function setCrashReporter(reporter: CrashReporter): void {
  crashReporter = reporter;
}

/**
 * Report an exception to the crash reporter (no-op if not configured).
 * Always logs to the diagnostics sink first; crash reporter is best-effort
 * after that and never throws.
 */
export function reportCrash(scope: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  errorLog(scope, e);
  try {
    crashReporter(scope, e);
  } catch {
    /* silent */
  }
}

export function verboseLog(scope: string, ...parts: readonly unknown[]): void {
  if (!verboseEnabled) return;
  sink.write("verbose", scope, parts);
}

export function warnLog(scope: string, ...parts: readonly unknown[]): void {
  sink.write("warn", scope, parts);
}

export function errorLog(scope: string, ...parts: readonly unknown[]): void {
  sink.write("error", scope, parts);
}

/**
 * Helper for use sites that need formatted output (e.g. tests).
 * Mirrors how the OutputChannel sink renders entries.
 */
export function formatLogLine(level: LogLevel, scope: string, parts: readonly unknown[]): string {
  const tag = level === "verbose" ? scope : `${scope} ${level.toUpperCase()}`;
  const body = parts
    .map((p) => {
      if (p instanceof Error) {
        return p.stack ?? `${p.name}: ${p.message}`;
      }
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");
  return `[${new Date().toISOString()}] [${tag}] ${body}`;
}
