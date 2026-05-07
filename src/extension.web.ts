/**
 * Web extension entry (vscode.dev / github.dev): no Node fs — sync engine not connected.
 * All commands from contributes are registered as stubs so the palette never throws
 * "command not found". Full sync remains Desktop-only.
 *
 * Implemented in this entrypoint:
 *  - Stub commands for all VSCodeSync palette actions (auto-generated list)
 *  - Workspaces tree with explanatory message
 *  - Full OAuth redirect URI handler (openExternal + vscode.env.uriScheme)
 *  - Lock-file emulation via vscode.workspace.fs (no node:fs)
 *  - powerMonitor stub (battery auto-pause disabled in web)
 *  - Git extension integration stub (branch detection best-effort)
 */
import * as vscode from "vscode";

import { WEB_STUB_COMMAND_IDS } from "./webStubCommands.generated.js";

const WEB_MSG =
  "VSCodeSync: синхронизация доступна в VS Code Desktop. В браузере откройте репозиторий локально для полного функционала.";

// ─── OAuth redirect handler ───────────────────────────────────────────────────

/**
 * Web OAuth flow using vscode.env.openExternal + UriHandler.
 * The extension registers itself as the redirect URI handler via vscode.env.uriScheme.
 *
 * Redirect URI to register in provider consoles:
 *   vscode://<publisher>.<extensionName>/oauth-callback
 *   e.g.  vscode://vscodesync.vscodesync/oauth-callback
 *
 * Flows supported:
 *  - OneDrive: Authorization code + PKCE (state parameter)
 *  - Google Drive: Authorization code (state parameter)
 *  - Others: forwarded to Desktop
 */
interface PendingOAuthRequest {
  state: string;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingOAuthRequests = new Map<string, PendingOAuthRequest>();

function registerUriHandlerWeb(_context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
      void (async () => {
        const params = new URLSearchParams(uri.query);
        const state = params.get("state");
        const code = params.get("code");
        const error = params.get("error_description") ?? params.get("error");

        if (state && pendingOAuthRequests.has(state)) {
          const pending = pendingOAuthRequests.get(state)!;
          pendingOAuthRequests.delete(state);
          clearTimeout(pending.timer);
          if (error) {
            pending.reject(new Error(error));
          } else if (code) {
            pending.resolve(code);
          } else {
            pending.reject(new Error("OAuth redirect: missing code parameter"));
          }
          return;
        }

        // No pending request — inform user about Desktop
        await vscode.window.showInformationMessage(
          `VSCodeSync (Web): OAuth redirect получен. Для полной авторизации используйте VS Code Desktop.`,
        );
      })();
    },
  });
}

/**
 * Start a web OAuth flow: opens browser → waits for redirect → returns auth code.
 * @param authUrl - Authorization URL (includes state, redirect_uri=vscode://..., PKCE challenge)
 * @param state   - State parameter for CSRF protection.
 * @param timeoutMs - Timeout in ms (default 5 min).
 */
export async function webOAuthGetCode(
  authUrl: string,
  state: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOAuthRequests.delete(state);
      reject(new Error("VSCodeSync Web OAuth: timeout waiting for redirect"));
    }, timeoutMs);
    pendingOAuthRequests.set(state, { state, resolve, reject, timer });
    void vscode.env.openExternal(vscode.Uri.parse(authUrl));
  });
  return code;
}

/**
 * Build the redirect URI for web OAuth flows.
 * Format: vscode://<publisher>.<name>/oauth-callback
 */
export function buildWebOAuthRedirectUri(): string {
  const EXT_ID = "borodatych.vscodesyncfiles";
  const ext = vscode.extensions.getExtension(EXT_ID);
  const pkg = ext?.packageJSON as { publisher?: string; name?: string } | undefined;
  const publisher = pkg?.publisher ?? "borodatych";
  const name = pkg?.name ?? "vscodesyncfiles";
  return `${vscode.env.uriScheme}://${publisher}.${name}/oauth-callback`;
}

// ─── Lock-file via vscode.workspace.fs ───────────────────────────────────────

/**
 * Web lock-file emulation using vscode.workspace.fs (no node:fs available).
 * Uses a workspace-relative path: .vscode/vscodesync-locks/{hash}.lock
 * PID check is omitted (not available in browser context).
 */
const WEB_LOCK_DIR_SEGMENT = ".vscode/vscodesync-locks";

interface WebLockBody {
  nonce: string;
  lockedAt: string;
  instanceId: string;
}

/** Session-level nonce to identify this extension instance. */
const WEB_INSTANCE_ID = Math.random().toString(36).slice(2);
let webLockUri: vscode.Uri | null = null;
let webLockNonce: string | null = null;

/** Acquire a workspace-scoped lock file via vscode.workspace.fs. */
export async function acquireWebLock(workspaceUri: vscode.Uri, hash: string): Promise<boolean> {
  const lockUri = vscode.Uri.joinPath(workspaceUri, WEB_LOCK_DIR_SEGMENT, `${hash}.lock`);
  const nonce = Math.random().toString(36).slice(2);

  try {
    // Create lock dir
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(workspaceUri, WEB_LOCK_DIR_SEGMENT),
    );

    // Try to read existing lock
    try {
      const existing = await vscode.workspace.fs.readFile(lockUri);
      const body = JSON.parse(Buffer.from(existing).toString("utf8")) as Partial<WebLockBody>;
      // In web context we can't check PID — check instanceId to handle same-instance re-entry
      if (body.instanceId && body.instanceId !== WEB_INSTANCE_ID) {
        // Another instance holds the lock — treat as held (conservative)
        return false;
      }
    } catch {
      /* lock file doesn't exist — proceed */
    }

    const body: WebLockBody = {
      nonce,
      lockedAt: new Date().toISOString(),
      instanceId: WEB_INSTANCE_ID,
    };
    await vscode.workspace.fs.writeFile(
      lockUri,
      Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8"),
    );
    webLockUri = lockUri;
    webLockNonce = nonce;
    return true;
  } catch {
    return false;
  }
}

/** Release the web lock file. */
export async function releaseWebLock(): Promise<void> {
  if (!webLockUri || !webLockNonce) return;
  const uri = webLockUri;
  const nonce = webLockNonce;
  webLockUri = null;
  webLockNonce = null;
  try {
    const existing = await vscode.workspace.fs.readFile(uri);
    const body = JSON.parse(Buffer.from(existing).toString("utf8")) as Partial<WebLockBody>;
    if (body.nonce === nonce) {
      await vscode.workspace.fs.delete(uri, { useTrash: false });
    }
  } catch {
    /* ignore — file may have already been deleted */
  }
}

// ─── powerMonitor stub ────────────────────────────────────────────────────────

/**
 * In web context, powerMonitor (battery/metered detection) is unavailable.
 * Auto-pause by battery is disabled. This stub provides the same interface
 * so callers can safely import without platform-checking.
 */
export const webPowerMonitorStub = {
  /** Always returns null in web context (battery state unknown). */
  getBatteryPercent(): Promise<number | null> {
    return Promise.resolve(null);
  },
  /** Always false in web context. */
  isMeteredConnection(): boolean {
    return false;
  },
  /** No-op: battery monitoring not available in browser. */
  startMonitoring(_callback: (pct: number | null) => void): void {
    // battery monitoring is unavailable in web
  },
  stopMonitoring(): void {
    // no-op
  },
};

// ─── Git extension integration stub ──────────────────────────────────────────

/**
 * Attempt to get the current git branch from VS Code's built-in Git extension.
 * Works in web environments where the git extension is available (e.g. github.dev).
 * Returns null if git extension is unavailable or no branch found.
 */
export async function getWebGitBranch(workspaceFolder?: vscode.WorkspaceFolder): Promise<string | null> {
  try {
    // VS Code Git extension exposes its API via getExtension
    const gitExtension = vscode.extensions.getExtension<GitExtensionApi>("vscode.git");
    if (!gitExtension) return null;

    const api = gitExtension.isActive
      ? gitExtension.exports.getAPI(1)
      : (await gitExtension.activate()).getAPI(1);

    if (api.repositories.length === 0) return null;

    const folder = workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    const repo = folder
      ? api.repositories.find((r) => r.rootUri.fsPath.startsWith(folder.uri.fsPath))
          ?? api.repositories[0]
      : api.repositories[0];

    return repo.state.HEAD?.name ?? null;
  } catch {
    return null;
  }
}

// Minimal type shim for VS Code Git extension API (avoids importing @types/vscode-git)
interface GitExtensionApi {
  getAPI(version: 1): {
    repositories: {
      rootUri: vscode.Uri;
      state: { HEAD?: { name?: string } };
    }[];
  };
}

// ─── Extension activate / deactivate ─────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const stub = async (): Promise<void> => {
    await vscode.window.showWarningMessage(WEB_MSG);
  };

  for (const id of WEB_STUB_COMMAND_IDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, stub));
  }

  // OAuth redirect URI handler
  context.subscriptions.push(registerUriHandlerWeb(context));

  // Workspaces tree — informational only
  const tree = new (class implements vscode.TreeDataProvider<string> {
    getTreeItem(label: string): vscode.TreeItem {
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.tooltip = new vscode.MarkdownString(WEB_MSG);
      return item;
    }
    getChildren(): Thenable<string[]> {
      return Promise.resolve([
        "Синхронизация недоступна в браузере — используйте VS Code Desktop.",
      ]);
    }
  })();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("vscodesync.workspaces", tree));

  // Status bar indicator for web
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = "$(cloud) VSCodeSync (Web)";
  statusBar.tooltip = WEB_MSG;
  statusBar.show();
  context.subscriptions.push(statusBar);
}

export function deactivate(): void {
  void releaseWebLock();
}
