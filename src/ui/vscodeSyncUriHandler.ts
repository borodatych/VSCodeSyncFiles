/**
 * v0.15 W05 — `vscodesync://` URI handler.
 *
 * VS Code dispatches custom-scheme URIs to extensions via
 * `vscode.window.registerUriHandler`. The host activates the extension
 * automatically on `onUri` event. From an external client (browser,
 * Slack/Telegram chat, etc.) the user clicks
 *   vscode://borodatych.vscodesyncfiles/workspace/<wid>/<rel>
 * VS Code strips the leading `vscode://<ext-id>` and passes the rest as
 * the `path` portion of `vscode.Uri`. Our parser was written against the
 * synthetic `vscodesync://workspace/<wid>/<rel>` shape; this handler
 * normalises the incoming Uri into that form before parsing.
 */
import * as vscode from "vscode";
import * as path from "node:path";
import {
  parseVscodeSyncUri,
  URI_COMMAND_WHITELIST,
} from "../core/vscodesyncUriParser.js";
import { WorkspaceConfigManager } from "../core/workspaceConfigManager.js";

export function registerVscodeSyncUriHandler(context: vscode.ExtensionContext): void {
  const handler: vscode.UriHandler = {
    handleUri: async (uri: vscode.Uri): Promise<void> => {
      // VS Code passes `vscode-insiders://<ext-id>/<...>` as
      //   uri.scheme = "vscode-insiders"
      //   uri.authority = "<ext-id>"
      //   uri.path = "/<...>"
      // Rebuild a `vscodesync://` shape our parser understands.
      const segments = uri.path.split("/").filter((s) => s.length > 0);
      if (segments.length < 1) return;
      // v0.17 A9 — validate the host segment BEFORE synthesising. Returns
      // a precise message to the user instead of generic `scheme_mismatch`.
      const host = segments[0];
      // v0.18 W1 — `vscodesync://invite/<payload>` shortcuts to the
      // accept-invite command. We pass the FULL incoming URI string so
      // decodeInviteLink can validate base64+expiry on its own.
      if (host === "invite") {
        const fullLink = `vscodesync://invite/${segments.slice(1).join("/")}`;
        await vscode.commands.executeCommand("vscodesync.acceptInviteLink", fullLink);
        return;
      }
      if (host !== "workspace" && host !== "command") {
        void vscode.window.showWarningMessage(
          `VSCodeSync: ссылка с неизвестным сегментом '${host}'. Ожидалось workspace/... или command/...`,
        );
        return;
      }
      const tail = segments.length > 1 ? `/${segments.slice(1).join("/")}` : "";
      const synth = `vscodesync://${host}${tail}${uri.query ? `?${uri.query}` : ""}`;
      const parsed = parseVscodeSyncUri(synth);
      if (!parsed.ok) {
        void vscode.window.showWarningMessage(
          `VSCodeSync: ссылка не распознана (${parsed.error}).`,
        );
        return;
      }
      const action = parsed.action;
      switch (action.kind) {
        case "openWorkspace": {
          // Surface the Workspaces tree view via the registered focus
          // command (vscodesync.focusWorkspacesView, see package.json).
          await vscode.commands.executeCommand("vscodesync.focusWorkspacesView");
          void vscode.window.showInformationMessage(
            `VSCodeSync: открыт workspace ${action.workspaceId} (если подключён локально).`,
          );
          break;
        }
        case "openFile": {
          // v0.17 A3 — opening tracked file requires Workspace Trust; the
          // URI shape itself is benign but `openTextDocument` against an
          // arbitrary local path needs the trust boundary checked.
          if (!vscode.workspace.isTrusted) {
            void vscode.window.showWarningMessage(
              "VSCodeSync: открытие файла по vscodesync:// требует Workspace Trust.",
            );
            return;
          }
          // Walk all open folders; find the workspace and open the file.
          const folders = vscode.workspace.workspaceFolders ?? [];
          for (const folder of folders) {
            try {
              const wc = await WorkspaceConfigManager.load(folder.uri.fsPath);
              const fe = wc.files.find(
                (f) =>
                  f.workspaceId === action.workspaceId &&
                  f.localPath === action.posixRel,
              );
              if (fe) {
                const abs = path.join(folder.uri.fsPath, ...action.posixRel.split("/"));
                const doc = await vscode.workspace.openTextDocument(abs);
                await vscode.window.showTextDocument(doc);
                return;
              }
            } catch { /* try next folder */ }
          }
          await vscode.window.showWarningMessage(
            `VSCodeSync: workspace ${action.workspaceId} не подключён локально. Используйте Attach.`,
          );
          break;
        }
        case "runCommand": {
          if (!URI_COMMAND_WHITELIST.has(action.commandId)) {
            await vscode.window.showErrorMessage(
              `VSCodeSync: команда ${action.commandId} не разрешена через URI.`,
            );
            return;
          }
          await vscode.commands.executeCommand(action.commandId);
          break;
        }
      }
    },
  };
  context.subscriptions.push(vscode.window.registerUriHandler(handler));
}
