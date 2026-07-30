import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import type { SecretStore } from "../core/types.js";
import { readOneDriveTokenBundle } from "../providers/onedrive/onedriveProvider.js";
import {
  graphCreateDriveRootSubscription,
  graphDeleteSubscription,
  graphRenewSubscription,
} from "../providers/onedrive/graphWebhookSubscription.js";
import { startGraphWebhookLocalServer, type GraphWebhookLocalServer } from "./graphWebhookLocalServer.js";
import type { QuietFullSyncAllFoldersDeps } from "./quietFullSyncAllFolders.js";
import { runQuietFullSyncAllFolders } from "./quietFullSyncAllFolders.js";
import {
  activateWebhookPushFor,
  deactivateWebhookPushIfProvider,
  recordWebhookPushNotification,
} from "./webhookChannelCoordinator.js";
import { createAndStartSmeeRelay, type SmeeRelay } from "./webhookTunnel.js";
import { decideWebhookRenewTick } from "../core/webhookLifecycleRenewTickDecision.js";
import { createWebhookRenewalLoop, type RenewalLoopHandle } from "../core/webhookRenewalLoop.js";
import { planWebhookLifecycleReconcile } from "../core/webhookLifecycleReconcileDecision.js";

const CFG = "vscodesync";
const STATE_NAME = "onedrive-graph-subscription.json";

interface PersistedState {
  subscriptionId: string;
  expirationDateTime: string;
  clientState: string;
  notificationUrl: string;
}

let serverHandle: GraphWebhookLocalServer | undefined;
let renewLoop: ReturnType<typeof setInterval> | undefined;
let renewalDriver: RenewalLoopHandle | undefined;
let tunnelRelay: SmeeRelay | undefined;

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


export interface OneDriveWebhookLifecycleHandle {
  refresh: () => Promise<void>;
}

export function registerOneDriveWebhookLifecycle(
  context: vscode.ExtensionContext,
  globalConfig: GlobalConfigManager,
  secrets: SecretStore,
  syncDeps: QuietFullSyncAllFoldersDeps,
  out: vscode.OutputChannel,
): OneDriveWebhookLifecycleHandle {
  const stopRelay = (): void => {
    if (tunnelRelay) {
      const handle = tunnelRelay;
      tunnelRelay = undefined;
      try {
        handle.dispose();
      } catch (e: unknown) {
        log(out, `smee relay dispose: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const stopServer = (): void => {
    if (serverHandle) {
      serverHandle.close();
      serverHandle = undefined;
    }
    stopRelay();
  };

  const stopRenew = (): void => {
    if (renewLoop !== undefined) {
      clearInterval(renewLoop);
      renewLoop = undefined;
    }
    if (renewalDriver !== undefined) {
      renewalDriver.dispose();
      renewalDriver = undefined;
    }
  };

  let reconcileChain: Promise<void> = Promise.resolve();

  const reconcileBody = async (): Promise<void> => {
    stopRenew();
    stopServer();
    deactivateWebhookPushIfProvider("onedrive");

    const cfg = vscode.workspace.getConfiguration(CFG);
    const enabled = cfg.get<boolean>("webhooks.enabled", false);
    let notificationUrl = cfg.get<string>("webhooks.url", "").trim();
    const localPort = cfg.get<number>("webhooks.localPort", 0);
    const tunnelEnabled = cfg.get<boolean>("webhooks.tunnelEnabled", false);

    const gc = await globalConfig.load();
    const activeProviderMatches = gc.activeProvider === "onedrive";

    // Resolve the public ingress URL before invoking the planner — smee
    // tunnel only spins up when we are still the active provider AND the
    // user hasn't supplied a static URL.
    if (activeProviderMatches && enabled && !notificationUrl && tunnelEnabled) {
      try {
        const relay = await createAndStartSmeeRelay(() => {
          recordWebhookPushNotification();
          void runQuietFullSyncAllFolders({ ...syncDeps, trigger: "auto" });
        });
        tunnelRelay = relay;
        notificationUrl = relay.channelUrl;
        log(out, `smee tunnel active: ${notificationUrl}`);
        await vscode.window.showInformationMessage(
          `VSCodeSync: webhook tunnel активен (smee) — ${notificationUrl}`,
          "OK",
        );
      } catch (e) {
        log(out, `smee relay failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const bundle = activeProviderMatches ? await readOneDriveTokenBundle(secrets) : null;
    const accessToken = bundle?.accessToken ?? null;
    const persistedState = await readState(globalConfig);

    const plan = planWebhookLifecycleReconcile({
      webhooksEnabled: enabled,
      resolvedNotificationUrl: notificationUrl,
      localPort,
      activeProviderMatches,
      hasToken: accessToken !== null,
      persistedState: persistedState
        ? {
            subscriptionId: persistedState.subscriptionId,
            expirationDateTime: persistedState.expirationDateTime,
            notificationUrl: persistedState.notificationUrl,
            clientState: persistedState.clientState,
          }
        : null,
    });

    // Reserve a single clientState for both the local server (if any) and
    // the create_subscription action — Graph pairs them via this token.
    const reservedClientState = persistedState?.clientState ?? randomBytes(24).toString("hex");
    let workingState: PersistedState | null = persistedState;

    for (const action of plan.actions) {
      switch (action.kind) {
        case "delete_stale_subscription": {
          if (accessToken) {
            try {
              await graphDeleteSubscription(accessToken, action.subscriptionId);
              log(out, `Removed Graph subscription ${action.subscriptionId} (${action.reason}).`);
            } catch (e) {
              log(out, `Graph subscription cleanup: ${e instanceof Error ? e.message : String(e)}`);
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
          // Reachable only as a sentinel; planner returns lifecycleActive=false
          // with inactiveReason="no_token" instead. Surface and stop.
          log(out, "OneDrive Graph webhooks: not signed in to OneDrive.");
          return;
        }
        case "start_local_server": {
          try {
            serverHandle = await startGraphWebhookLocalServer({
              port: action.port,
              graphClientState: reservedClientState,
              onDriveChangeHint: () => {
                recordWebhookPushNotification();
                void runQuietFullSyncAllFolders({
                  ...syncDeps,
                  trigger: "auto",
                });
              },
            });
            log(out, `Local webhook listener on 127.0.0.1:${String(action.port)} (use HTTPS tunnel → this port).`);
          } catch (e) {
            log(out, `Failed to bind local webhook port ${String(action.port)}: ${e instanceof Error ? e.message : String(e)}`);
            return;
          }
          break;
        }
        case "create_subscription": {
          if (!accessToken) return;
          try {
            const created = await graphCreateDriveRootSubscription(
              accessToken,
              notificationUrl,
              reservedClientState,
            );
            workingState = {
              subscriptionId: created.id,
              expirationDateTime: created.expirationDateTime,
              clientState: reservedClientState,
              notificationUrl,
            };
            await writeState(globalConfig, workingState);
            log(out, `Graph subscription ${created.id} until ${created.expirationDateTime}.`);
          } catch (e) {
            log(out, `Graph subscription failed: ${e instanceof Error ? e.message : String(e)}`);
            stopServer();
            return;
          }
          break;
        }
        case "keep_subscription": {
          // No-op — persisted state already matches the resolved URL.
          break;
        }
        case "register_webhook_push": {
          activateWebhookPushFor("onedrive");
          break;
        }
        case "start_renew_loop": {
          renewalDriver = createWebhookRenewalLoop({
            fetchSubscriptions: async () => {
              const s = await readState(globalConfig);
              const cfgInner = vscode.workspace.getConfiguration(CFG);
              const gci = await globalConfig.load();
              const b = await readOneDriveTokenBundle(secrets);
              const decision = decideWebhookRenewTick({
                state: s ? { subscriptionId: s.subscriptionId, expirationDateTime: s.expirationDateTime } : null,
                webhooksEnabled: cfgInner.get<boolean>("webhooks.enabled", false),
                activeProviderMatches: gci.activeProvider === "onedrive",
                hasToken: Boolean(b?.accessToken),
              });
              if (decision.kind !== "renew_now" || !s || !b?.accessToken) return [];
              return [{ id: s.subscriptionId, expiresAtIso: s.expirationDateTime }];
            },
            onRenew: async (sub) => {
              const s = await readState(globalConfig);
              const b = await readOneDriveTokenBundle(secrets);
              if (!s || !b?.accessToken) return;
              try {
                const newExp = await graphRenewSubscription(b.accessToken, sub.id);
                await writeState(globalConfig, { ...s, expirationDateTime: newExp });
                log(out, `Subscription renewed until ${newExp}.`);
              } catch (e) {
                log(out, `Renew failed: ${e instanceof Error ? e.message : String(e)}`);
                deactivateWebhookPushIfProvider("onedrive");
              }
            },
            onRecreate: (sub) => {
              log(out, `Subscription ${sub.id} expired — re-running reconcile.`);
              void refresh();
            },
            onLog: (line) => { log(out, line); },
          });
          renewalDriver.start();
          break;
        }
      }
    }

    if (!plan.lifecycleActive && plan.inactiveReason === "no_token") {
      log(out, "OneDrive Graph webhooks: not signed in to OneDrive.");
    }
  };

  const refresh = (): Promise<void> => {
    reconcileChain = reconcileChain
      .then(() => reconcileBody())
      .catch((e: unknown) => {
        log(out, `Reconcile error: ${e instanceof Error ? e.message : String(e)}`);
      });
    return reconcileChain;
  };

  context.subscriptions.push(
    new vscode.Disposable(() => {
      stopRenew();
      stopServer();
      deactivateWebhookPushIfProvider("onedrive");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CFG}.webhooks.enabled`) ||
        e.affectsConfiguration(`${CFG}.webhooks.url`) ||
        e.affectsConfiguration(`${CFG}.webhooks.localPort`) ||
        e.affectsConfiguration(`${CFG}.webhooks.fallbackAfterMinutes`) ||
        e.affectsConfiguration(`${CFG}.webhooks.tunnelEnabled`)
      ) {
        void refresh();
      }
    }),
  );

  void refresh();

  return { refresh };
}
