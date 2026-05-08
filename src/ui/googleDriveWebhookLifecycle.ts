import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SecretStore } from "../core/types.js";
import { readGdriveTokens } from "../providers/gdrive/gdriveTokens.js";
import {
  getGdriveVsCodeSyncRootFolderId,
  gdriveStartFolderWatch,
  gdriveStopPushChannel,
} from "../providers/gdrive/gdrivePushChannelApi.js";
import { startGraphWebhookLocalServer, type GraphWebhookLocalServer } from "./graphWebhookLocalServer.js";
import type { QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import {
  activateWebhookPushFor,
  deactivateWebhookPushIfProvider,
  recordWebhookPushNotification,
} from "./webhookChannelCoordinator.js";
import { reconcileFromFlags } from "./webhookExpirationMath.js";
import { decideWebhookRenewTick } from "../core/webhookLifecycleRenewTickDecision.js";
import { gdriveExpirationToIso } from "../core/gdrivePushChannelResponseDecoder.js";

const CFG = "vscodesync";
const STATE_NAME = "gdrive-push-channel.json";

interface PersistedState {
  channelId: string;
  resourceId: string;
  /** Milliseconds since epoch as string (Google API). */
  expiration: string;
  folderId: string;
  notificationUrl: string;
  channelToken: string;
}

let serverHandle: GraphWebhookLocalServer | undefined;
let renewLoop: ReturnType<typeof setInterval> | undefined;

function statePath(globalConfig: GlobalConfigManager): string {
  return path.join(globalConfig.getStorageDir(), STATE_NAME);
}

async function readState(globalConfig: GlobalConfigManager): Promise<PersistedState | null> {
  try {
    const raw = await fs.readFile(statePath(globalConfig), "utf8");
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

async function writeState(globalConfig: GlobalConfigManager, s: PersistedState): Promise<void> {
  const dir = globalConfig.getStorageDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(statePath(globalConfig), `${JSON.stringify(s, null, 2)}\n`, "utf8");
}

async function clearState(globalConfig: GlobalConfigManager): Promise<void> {
  try {
    await fs.unlink(statePath(globalConfig));
  } catch {
    /* noop */
  }
}

function log(ch: vscode.OutputChannel, msg: string): void {
  ch.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

/** True if channel expires within slackMs or invalid. */
function isNearOrPastGdriveExpiration(expirationMsStr: string, slackMs: number): boolean {
  const n = Number(expirationMsStr);
  if (!Number.isFinite(n)) {
    return true;
  }
  return n - slackMs <= Date.now();
}

export interface GoogleDriveWebhookLifecycleHandle {
  refresh: () => Promise<void>;
}

export function registerGoogleDriveWebhookLifecycle(
  context: vscode.ExtensionContext,
  globalConfig: GlobalConfigManager,
  secrets: SecretStore,
  syncDeps: QuietFullSyncAllFoldersDeps,
  out: vscode.OutputChannel,
): GoogleDriveWebhookLifecycleHandle {
  const stopServer = (): void => {
    if (serverHandle) {
      serverHandle.close();
      serverHandle = undefined;
    }
  };

  const stopRenew = (): void => {
    if (renewLoop !== undefined) {
      clearInterval(renewLoop);
      renewLoop = undefined;
    }
  };

  let reconcileChain: Promise<void> = Promise.resolve();

  const reconcileBody = async (): Promise<void> => {
    stopRenew();
    stopServer();
    deactivateWebhookPushIfProvider("gdrive");

    const cfg = vscode.workspace.getConfiguration(CFG);
    const enabled = cfg.get<boolean>("webhooks.enabled", false);
    const notificationUrl = cfg.get<string>("webhooks.url", "").trim();
    const localPort = cfg.get<number>("webhooks.localPort", 0);

    const gc = await globalConfig.load();

    if (gc.activeProvider !== "gdrive") {
      const prev = await readState(globalConfig);
      if (prev) {
        const bundle = await readGdriveTokens(secrets);
        if (bundle?.accessToken) {
          try {
            await gdriveStopPushChannel(bundle.accessToken, prev.channelId, prev.resourceId);
            log(out, `Stopped Google Drive channel ${prev.channelId} (active provider is not Google Drive).`);
          } catch (e) {
            log(out, `Google Drive channel cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await clearState(globalConfig);
      }
      return;
    }

    if (!enabled || !notificationUrl) {
      const prev = await readState(globalConfig);
      if (prev) {
        const bundle = await readGdriveTokens(secrets);
        if (bundle?.accessToken) {
          try {
            await gdriveStopPushChannel(bundle.accessToken, prev.channelId, prev.resourceId);
            log(out, `Stopped Google Drive channel ${prev.channelId} (webhooks disabled or URL cleared).`);
          } catch (e) {
            log(out, `Google Drive channel cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await clearState(globalConfig);
      }
      return;
    }

    const bundle = await readGdriveTokens(secrets);
    if (!bundle?.accessToken) {
      log(out, "Google Drive webhooks: not signed in to Google Drive.");
      return;
    }
    const token = bundle.accessToken;

    let state = await readState(globalConfig);
    if (state) {
      const decision = reconcileFromFlags({
        hasExisting: true,
        urlOk: state.notificationUrl === notificationUrl,
        withinValidSlack: isNearOrPastGdriveExpiration(state.expiration, 600_000),
        withinRenewSlack: isNearOrPastGdriveExpiration(state.expiration, 3600_000),
      });
      if (decision.action === "create") {
        try {
          await gdriveStopPushChannel(token, state.channelId, state.resourceId);
        } catch {
          /* channel may already be gone */
        }
        state = null;
        await clearState(globalConfig);
      }
    }

    const channelToken = state?.channelToken ?? randomBytes(24).toString("hex");

    if (localPort > 0) {
      try {
        serverHandle = await startGraphWebhookLocalServer({
          port: localPort,
          graphClientState: "__gdrive_unused__",
          googleChannelToken: channelToken,
          onDriveChangeHint: () => {
            recordWebhookPushNotification();
            void runQuietFullSyncAllFolders({
              ...syncDeps,
              bypassSchedule: true,
            });
          },
        });
        log(out, `Local webhook listener on 127.0.0.1:${String(localPort)} (Google push; tunnel → this port).`);
      } catch (e) {
        log(out, `Failed to bind local webhook port ${String(localPort)}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (!state) {
      try {
        const folderId = await getGdriveVsCodeSyncRootFolderId(token);
        const channelId = randomUUID();
        const created = await gdriveStartFolderWatch(token, folderId, channelId, notificationUrl, channelToken);
        state = {
          channelId: created.id,
          resourceId: created.resourceId,
          expiration: created.expiration,
          folderId,
          notificationUrl,
          channelToken,
        };
        await writeState(globalConfig, state);
        log(out, `Google Drive push channel ${created.id} until expiration=${created.expiration}.`);
      } catch (e) {
        log(out, `Google Drive files.watch failed: ${e instanceof Error ? e.message : String(e)}`);
        stopServer();
        return;
      }
    }

    activateWebhookPushFor("gdrive");

    const renewTick = async (): Promise<void> => {
      const s = await readState(globalConfig);
      const cfgInner = vscode.workspace.getConfiguration(CFG);
      const gci = await globalConfig.load();
      const b = await readGdriveTokens(secrets);
      const expirationIso = s ? gdriveExpirationToIso(s.expiration) ?? "" : "";
      const decision = decideWebhookRenewTick({
        state: s ? { subscriptionId: s.channelId, expirationDateTime: expirationIso } : null,
        webhooksEnabled: cfgInner.get<boolean>("webhooks.enabled", false),
        activeProviderMatches: gci.activeProvider === "gdrive",
        hasToken: Boolean(b?.accessToken),
        renewSlackMs: 3600_000,
      });
      if (decision.kind !== "renew_now") {
        return;
      }
      if (!s || !b?.accessToken) {
        return;
      }
      try {
        await gdriveStopPushChannel(b.accessToken, s.channelId, s.resourceId);
        const channelId = randomUUID();
        const created = await gdriveStartFolderWatch(
          b.accessToken,
          s.folderId,
          channelId,
          s.notificationUrl,
          s.channelToken,
        );
        await writeState(globalConfig, {
          ...s,
          channelId: created.id,
          resourceId: created.resourceId,
          expiration: created.expiration,
        });
        log(out, `Google Drive channel renewed ${created.id} until expiration=${created.expiration}.`);
      } catch (e) {
        log(out, `Google Drive channel renew failed: ${e instanceof Error ? e.message : String(e)}`);
        deactivateWebhookPushIfProvider("gdrive");
      }
    };

    renewLoop = setInterval(() => {
      void renewTick();
    }, 4 * 60_000);
  };

  const refresh = (): Promise<void> => {
    reconcileChain = reconcileChain
      .then(() => reconcileBody())
      .catch((e: unknown) => {
        log(out, `Google webhooks reconcile error: ${e instanceof Error ? e.message : String(e)}`);
      });
    return reconcileChain;
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      stopRenew();
      stopServer();
      deactivateWebhookPushIfProvider("gdrive");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CFG}.webhooks.enabled`) ||
        e.affectsConfiguration(`${CFG}.webhooks.url`) ||
        e.affectsConfiguration(`${CFG}.webhooks.localPort`) ||
        e.affectsConfiguration(`${CFG}.webhooks.fallbackAfterMinutes`)
      ) {
        void refresh();
      }
    }),
  );

  void refresh();

  return { refresh };
}
