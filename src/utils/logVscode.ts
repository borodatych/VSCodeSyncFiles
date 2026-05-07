import * as vscode from "vscode";
import {
  formatLogLine,
  setCrashReporter,
  setLogSink,
  setVerboseEnabled,
  type LogSink,
} from "./log.js";

export function initLog(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("VSCodeSync · Diagnostics");
  context.subscriptions.push(channel);

  const sink: LogSink = {
    write(level, scope, parts) {
      channel.appendLine(formatLogLine(level, scope, parts));
    },
  };
  setLogSink(sink);
  refreshVerbose();

  // Crash reporter: forwards to a TelemetryLogger when telemetry is enabled.
  // Errors are scrubbed by the telemetry layer (no paths / file names) before
  // any optional ingest URL is hit. Disabled by default.
  const telemetryLogger = vscode.env.createTelemetryLogger(
    {
      sendEventData: () => {
        /* unused: only error data flows through here */
      },
      sendErrorData: () => {
        /* relies on default vscode pipeline; ingest is wired separately */
      },
    },
    { ignoreUnhandledErrors: true },
  );
  context.subscriptions.push(telemetryLogger);

  setCrashReporter((scope, error) => {
    if (!vscode.env.isTelemetryEnabled) return;
    const optIn = vscode.workspace
      .getConfiguration("vscodesync")
      .get<boolean>("telemetry", false);
    if (!optIn) return;
    // Wrap so VS Code's telemetry redactor sees a real Error.
    const tagged = error instanceof Error ? error : new Error(String(error));
    tagged.message = `[${scope}] ${tagged.message}`;
    telemetryLogger.logError(tagged);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscodesync.notificationLevel")) {
        refreshVerbose();
      }
    }),
  );
}

function refreshVerbose(): void {
  const level = vscode.workspace
    .getConfiguration("vscodesync")
    .get<string>("notificationLevel", "normal");
  setVerboseEnabled(level === "verbose");
}
