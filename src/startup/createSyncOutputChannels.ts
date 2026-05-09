/**
 * v2.6.7 — sync-related output channels factory.
 *
 * `extension.ts` previously created `Preview` + `Health Check` channels
 * inline. Both are owned for the entire activate lifecycle and pushed
 * into `context.subscriptions`. This helper bundles the creation +
 * subscription registration so the call site is one line.
 */
import * as vscode from "vscode";

export interface SyncOutputChannels {
  readonly syncPreviewChannel: vscode.OutputChannel;
  readonly healthCheckChannel: vscode.OutputChannel;
}

export function createSyncOutputChannels(
  context: vscode.ExtensionContext,
): SyncOutputChannels {
  const syncPreviewChannel = vscode.window.createOutputChannel("VSCodeSync · Preview");
  const healthCheckChannel = vscode.window.createOutputChannel("VSCodeSync · Health Check");
  context.subscriptions.push(syncPreviewChannel, healthCheckChannel);
  return { syncPreviewChannel, healthCheckChannel };
}
