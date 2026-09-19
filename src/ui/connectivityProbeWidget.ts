/**
 * v0.18 W5 — periodic connectivity probe + status-bar widget.
 *
 * Polls the active provider every 30 s with a cheap operation
 * (`listFolder` on the cloud root). Feeds results into the pure
 * `connectivityProbe` state machine. Surfaces an inline status-bar
 * item with online/degraded/offline icon. When the state flips to
 * `offline`, the existing autoSyncMode gates pick it up via
 * `shouldSuppressAutoSync` (exposed here as a singleton getter).
 */
import * as vscode from "vscode";
import {
  currentPollIntervalMs,
  onBackgroundPollProfileChanged,
} from "./backgroundPollSettings.js";
import { backgroundCloudAllowed } from "./backgroundCloudGate.js";
import {
  INITIAL_STATE,
  decayConnectivity,
  describeConnectivity,
  noteProbeFailure,
  noteProbeSuccess,
  shouldSuppressAutoSync,
  type ConnectivityState,
} from "../core/connectivityProbe.js";
import { CLOUD_ROOT_DIR } from "../core/cloudLayout.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";

const POLL_INTERVAL_MS = 30_000;
const DECAY_TICK_MS = 5_000;

let currentState: ConnectivityState = INITIAL_STATE;

/** Read-only accessor for trigger gates that need to suppress auto-sync. */
export function isCloudConnectivityOffline(): boolean {
  return shouldSuppressAutoSync(currentState);
}

export function getConnectivityState(): ConnectivityState {
  return currentState;
}

export interface ConnectivityProbeWidgetDeps {
  context: vscode.ExtensionContext;
  tryAuthenticatedProvider: () => Promise<ICloudProvider | null>;
}

export function registerConnectivityProbeWidget(
  deps: ConnectivityProbeWidgetDeps,
): vscode.Disposable {
  const { context } = deps;
  const item = vscode.window.createStatusBarItem(
    "vscodesync.connectivity",
    vscode.StatusBarAlignment.Left,
    85,
  );
  item.name = "VSCodeSync · Connectivity";
  item.command = "vscodesync.showStatus";

  const render = (): void => {
    const nowMs = Date.now();
    switch (currentState.status) {
      case "online":
        item.text = "$(cloud) online";
        item.backgroundColor = undefined;
        break;
      case "degraded":
        item.text = "$(cloud-download) degraded";
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "offline":
        item.text = "$(circle-slash) offline";
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        break;
      case "unknown":
        item.text = "$(question) ?";
        item.backgroundColor = undefined;
        break;
    }
    item.tooltip = describeConnectivity(currentState, nowMs);
    if (currentState.status === "unknown") {
      item.hide();
    } else {
      item.show();
    }
  };

  const probeOnce = async (): Promise<void> => {
    if (!backgroundCloudAllowed()) {
      return;
    }
    const provider = await deps.tryAuthenticatedProvider().catch(() => null);
    if (!provider) {
      // No authed provider — keep state as-is; we can't probe.
      return;
    }
    const nowMs = Date.now();
    try {
      await provider.listFolder(CLOUD_ROOT_DIR);
      currentState = noteProbeSuccess(currentState, nowMs);
    } catch {
      currentState = noteProbeFailure(currentState, nowMs);
    }
    render();
  };

  // Poll cadence follows the background profile: this widget is the most
  // frequent cloud caller we have, so it is the first thing a user on a
  // metered connection wants turned down.
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const armPollTimer = (): void => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    const interval = currentPollIntervalMs(POLL_INTERVAL_MS);
    if (interval === null) {
      return;
    }
    pollTimer = setInterval(() => { void probeOnce(); }, interval);
  };
  armPollTimer();
  const profileSub = onBackgroundPollProfileChanged(armPollTimer);
  const decayTimer = setInterval(() => {
    const prev = currentState;
    currentState = decayConnectivity(currentState, Date.now());
    if (prev !== currentState) render();
  }, DECAY_TICK_MS);

  // Initial probe — 5s after activate to avoid startup contention.
  const initTimer = setTimeout(() => { void probeOnce(); }, 5_000);

  const disposable = new vscode.Disposable(() => {
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
    }
    profileSub.dispose();
    clearInterval(decayTimer);
    clearTimeout(initTimer);
    item.dispose();
  });
  void context; // managed by caller via returned Disposable
  return disposable;
}
