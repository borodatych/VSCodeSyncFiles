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
import { planWebhookLifecycleReconcile } from "../core/webhookLifecycleReconcileDecision.js";

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
    const activeProviderMatches = gc.activeProvider === "gdrive";

    const bundle = activeProviderMatches ? await readGdriveTokens(secrets) : null;
    const accessToken = bundle?.accessToken ?? null;
    let workingState = await readState(globalConfig);

    // Pre-pass: GD's expiration validation can't be expressed by the planner
    // (it has no notion of channel TTL), so handle stale-expiration here.
    // The planner's URL-drift branch then sees `persistedState: null` and
    // naturally routes to create_subscription.
    if (workingState && activeProviderMatches && enabled && notificationUrl) {
      const decision = reconcileFromFlags({
        hasExisting: true,
        urlOk: workingState.notificationUrl === notificationUrl,
        withinValidSlack: isNearOrPastGdriveExpiration(workingState.expiration, 600_000),
        withinRenewSlack: isNearOrPastGdriveExpiration(workingState.expiration, 3600_000),
      });
      if (decision.action === "create" && workingState.notificationUrl === notificationUrl) {
        // URL is correct but expiration is stale → tear down before plan.
        if (accessToken) {
          try {
            await gdriveStopPushChannel(accessToken, workingState.channelId, workingState.resourceId);
            log(out, `Stopped Google Drive channel ${workingState.channelId} (expired).`);
          } catch (e) {
            log(out, `Google Drive channel cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await clearState(globalConfig);
        workingState = null;
      }
    }

    const plan = planWebhookLifecycleReconcile({
      webhooksEnabled: enabled,
      resolvedNotificationUrl: notificationUrl,
      localPort,
      activeProviderMatches,
      hasToken: accessToken !== null,
      persistedState: workingState
        ? {
            subscriptionId: workingState.channelId,
            expirationDateTime: gdriveExpirationToIso(workingState.expiration) ?? "",
            notificationUrl: workingState.notificationUrl,
            clientState: workingState.channelToken,
          }
        : null,
    });

    const reservedChannelToken = workingState?.channelToken ?? randomBytes(24).toString("hex");

    for (const action of plan.actions) {
      switch (action.kind) {
        case "delete_stale_subscription": {
          if (accessToken && workingState) {
            try {
              await gdriveStopPushChannel(accessToken, workingState.channelId, workingState.resourceId);
              log(out, `Stopped Google Drive channel ${action.subscriptionId} (${action.reason}).`);
            } catch (e) {
              log(out, `Google Drive channel cleanup: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          break;
        }
        case "clear_local_state": {
          await clearState(globalConfig);
          workingState = null;
          break;
        }
        case "abort_no_token": {
          log(out, "Google Drive webhooks: not signed in to Google Drive.");
          return;
        }
        case "start_local_server": {
          try {
            serverHandle = await startGraphWebhookLocalServer({
              port: action.port,
              graphClientState: null,
              googleChannelToken: reservedChannelToken,
              onDriveChangeHint: () => {
                recordWebhookPushNotification();
                void runQuietFullSyncAllFolders({
                  ...syncDeps,
                  bypassSchedule: true,
                });
              },
            });
            log(out, `Local webhook listener on 127.0.0.1:${String(action.port)} (Google push; tunnel → this port).`);
          } catch (e) {
            log(out, `Failed to bind local webhook port ${String(action.port)}: ${e instanceof Error ? e.message : String(e)}`);
            return;
          }
          break;
        }
        case "create_subscription": {
          if (!accessToken) return;
          try {
            const folderId = await getGdriveVsCodeSyncRootFolderId(accessToken);
            const channelId = randomUUID();
            const created = await gdriveStartFolderWatch(
              accessToken,
              folderId,
              channelId,
              notificationUrl,
              reservedChannelToken,
            );
            workingState = {
              channelId: created.id,
              resourceId: created.resourceId,
              expiration: created.expiration,
              folderId,
              notificationUrl,
              channelToken: reservedChannelToken,
            };
            await writeState(globalConfig, workingState);
            log(out, `Google Drive push channel ${created.id} until expiration=${created.expiration}.`);
          } catch (e) {
            log(out, `Google Drive files.watch failed: ${e instanceof Error ? e.message : String(e)}`);
            stopServer();
            return;
          }
          break;
        }
        case "keep_subscription": {
          break;
        }
        case "register_webhook_push": {
          activateWebhookPushFor("gdrive");
          break;
        }
        case "start_renew_loop": {
          renewLoop = setInterval(() => {
            void runRenewTick();
          }, action.intervalMs);
          break;
        }
      }
    }

    if (!plan.lifecycleActive && plan.inactiveReason === "no_token") {
      log(out, "Google Drive webhooks: not signed in to Google Drive.");
    }
  };

  const runRenewTick = async (): Promise<void> => {
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
