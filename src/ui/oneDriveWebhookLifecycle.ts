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
import {
  reconcileSubscription,
} from "./webhookExpirationMath.js";
import { decideWebhookRenewTick } from "../core/webhookLifecycleRenewTickDecision.js";

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
let smeeRelay: SmeeRelay | undefined;

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
  const stopSmee = (): void => {
    if (smeeRelay) {
      smeeRelay.dispose();
      smeeRelay = undefined;
    }
  };

  const stopServer = (): void => {
    if (serverHandle) {
      serverHandle.close();
      serverHandle = undefined;
    }
    stopSmee();
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
    deactivateWebhookPushIfProvider("onedrive");

    const cfg = vscode.workspace.getConfiguration(CFG);
    const enabled = cfg.get<boolean>("webhooks.enabled", false);
    let notificationUrl = cfg.get<string>("webhooks.url", "").trim();
    const localPort = cfg.get<number>("webhooks.localPort", 0);
    const tunnelEnabled = cfg.get<boolean>("webhooks.tunnelEnabled", false);

    const gc = await globalConfig.load();

    if (gc.activeProvider !== "onedrive") {
      const prev = await readState(globalConfig);
      if (prev) {
        const bundle = await readOneDriveTokenBundle(secrets);
        if (bundle?.accessToken) {
          try {
            await graphDeleteSubscription(bundle.accessToken, prev.subscriptionId);
            log(out, `Removed Graph subscription ${prev.subscriptionId} (active provider is not OneDrive).`);
          } catch (e) {
            log(out, `Graph subscription cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await clearState(globalConfig);
      }
      return;
    }

    // Start smee.io tunnel if enabled and no static URL provided
    if (enabled && !notificationUrl && tunnelEnabled) {
      try {
        const relay = await createAndStartSmeeRelay((payload) => {
          void payload; // payload dispatched; local server handles actual processing
          recordWebhookPushNotification();
          void runQuietFullSyncAllFolders({ ...syncDeps, bypassSchedule: true });
        });
        smeeRelay = relay;
        notificationUrl = relay.channelUrl;
        log(out, `smee.io tunnel active: ${notificationUrl}`);
        await vscode.window.showInformationMessage(
          `VSCodeSync: webhook tunnel активен — ${notificationUrl}`,
          "OK",
        );
      } catch (e) {
        log(out, `smee.io tunnel failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!enabled || !notificationUrl) {
      const prev = await readState(globalConfig);
      if (prev) {
        const bundle = await readOneDriveTokenBundle(secrets);
        if (bundle?.accessToken) {
          try {
            await graphDeleteSubscription(bundle.accessToken, prev.subscriptionId);
            log(out, `Removed Graph subscription ${prev.subscriptionId} (webhooks disabled or URL cleared).`);
          } catch (e: unknown) {
            log(out, `Graph subscription cleanup: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        await clearState(globalConfig);
      }
      return;
    }

    const bundle = await readOneDriveTokenBundle(secrets);
    if (!bundle?.accessToken) {
      log(out, "OneDrive Graph webhooks: not signed in to OneDrive.");
      return;
    }
    const token = bundle.accessToken;

    let state = await readState(globalConfig);
    if (state) {
      const decision = reconcileSubscription(
        { notificationUrl: state.notificationUrl, expirationDateTime: state.expirationDateTime },
        notificationUrl,
      );
      if (decision.action === "create") {
        try {
          await graphDeleteSubscription(token, state.subscriptionId);
        } catch {
          /* Graph may already have dropped it */
        }
        state = null;
        await clearState(globalConfig);
      }
    }

    const clientState = state?.clientState ?? randomBytes(24).toString("hex");

    if (localPort > 0) {
      try {
        serverHandle = await startGraphWebhookLocalServer({
          port: localPort,
          graphClientState: clientState,
          onDriveChangeHint: () => {
            recordWebhookPushNotification();
            void runQuietFullSyncAllFolders({
              ...syncDeps,
              bypassSchedule: true,
            });
          },
        });
        log(out, `Local webhook listener on 127.0.0.1:${String(localPort)} (use HTTPS tunnel → this port).`);
      } catch (e) {
        log(out, `Failed to bind local webhook port ${String(localPort)}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }

    if (!state) {
      try {
        const created = await graphCreateDriveRootSubscription(token, notificationUrl, clientState);
        state = {
          subscriptionId: created.id,
          expirationDateTime: created.expirationDateTime,
          clientState,
          notificationUrl,
        };
        await writeState(globalConfig, state);
        log(out, `Graph subscription ${created.id} until ${created.expirationDateTime}.`);
      } catch (e) {
        log(out, `Graph subscription failed: ${e instanceof Error ? e.message : String(e)}`);
        stopServer();
        return;
      }
    }

    activateWebhookPushFor("onedrive");

    const renewTick = async (): Promise<void> => {
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
      if (decision.kind !== "renew_now") {
        return;
      }
      if (!s || !b?.accessToken) {
        return;
      }
      try {
        const newExp = await graphRenewSubscription(b.accessToken, decision.subscriptionId);
        await writeState(globalConfig, { ...s, expirationDateTime: newExp });
        log(out, `Subscription renewed until ${newExp}.`);
      } catch (e) {
        log(out, `Renew failed: ${e instanceof Error ? e.message : String(e)}`);
        deactivateWebhookPushIfProvider("onedrive");
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
