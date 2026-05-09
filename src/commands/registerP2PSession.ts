/**
 * P2P session commands — `vscodesync.startP2PSession` +
 * `vscodesync.disconnectP2PSession` (v2.12.1).
 *
 * The command surfaces the wizard plan from {@link planP2PSessionWizard} as
 * a multi-step QuickPick. Each step is informational — the user sees exactly
 * what will happen (and why a particular transport / abort path was chosen).
 * Past `pick_role`, the wizard branches into either:
 *   - "cloud" transport (signaling round-trip via the active provider's
 *     manifest channel), or
 *   - "qr" transport (air-gapped offer/answer exchange).
 *
 * The signaling round-trip itself, the @roamhq/wrtc DataChannel, and the
 * `qrcode-terminal` rendering are intentionally gated behind the
 * `vscodesync.p2p.experimental` setting and the registry-driven session
 * lifecycle. When the gate is off (default), users see the plan and a clear
 * "experimental — enable in settings" hint instead of a half-spawned session
 * that fails with binding errors.
 *
 * `disconnectP2PSession` reads the registry, picks the primary session, and
 * removes it. Future iterations will hook the actual DataChannel close.
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  planP2PSessionWizard,
  type P2PSessionRole,
  type P2PSessionStep,
  type P2PSessionWarning,
} from "../core/p2pSessionWizardSteps.js";
import type { P2PSessionRegistry } from "../core/p2pSessionRegistry.js";
import type { ICloudProvider } from "../providers/cloudProviderTypes.js";
import type { GlobalConfigManager } from "../core/globalConfigManager.js";
import { createSignalingTransport } from "../ui/p2pSignalingTransport.js";
import { openP2PSession } from "../ui/p2pSessionRuntime.js";
import type { MirrorRegistryHandle } from "../ui/p2pFileTransferMirror.js";
import type { ActivityEventInput } from "../core/activityLog.js";

const CFG = "vscodesync";

export interface P2PSessionCommandsDeps {
  context: vscode.ExtensionContext;
  registry: P2PSessionRegistry;
  /** Optional engine factory — when present, the start command attempts a
   * real signaling round-trip + DataChannel open via `openP2PSession`. */
  tryAuthenticatedProvider?: () => Promise<ICloudProvider | null>;
  globalConfig?: GlobalConfigManager;
  /** v2.12.4 — when present, successful sessions register their authenticated
   * channel so engine-side `onPushFile` mirrors land on every connected peer. */
  mirrorRegistry?: MirrorRegistryHandle;
  /** v2.12.5 — sink for `p2p_session` events emitted by the runtime state
   * machine. Wire to the activity log so users see a recent-history view. */
  logSyncActivity?: (ev: ActivityEventInput) => void;
}

export function registerP2PSessionCommands(deps: P2PSessionCommandsDeps): vscode.Disposable[] {
  const { context } = deps;
  void context;

  return [
    vscode.commands.registerCommand("vscodesync.startP2PSession", () => runStartP2PSession(deps)),
    vscode.commands.registerCommand("vscodesync.disconnectP2PSession", () => runDisconnectP2PSession(deps)),
  ];
}

async function runStartP2PSession(deps: P2PSessionCommandsDeps): Promise<void> {
  const role = await pickRole();
  if (role === undefined) return;

  const cfg = vscode.workspace.getConfiguration(CFG);
  const experimentalEnabled = cfg.get<boolean>("p2p.experimental", false);
  const plan = planP2PSessionWizard({
    role,
    onlinePeerCount: experimentalEnabled ? 1 : 0,
    activeSessionCount: experimentalEnabled ? 1 : 0,
    cloudSignalingWritable: true,
  });
  await showPlanQuickPick(plan.steps, plan.warnings, plan.transport);

  if (!experimentalEnabled) {
    const choice = await vscode.window.showInformationMessage(
      "VSCodeSync: P2P session — экспериментальная фича. Включите её в настройках " +
      "(`vscodesync.p2p.experimental`) и повторите попытку.",
      "Открыть настройки", "Отмена",
    );
    if (choice === "Открыть настройки") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "vscodesync.p2p.experimental");
    }
    return;
  }

  if (!deps.tryAuthenticatedProvider || !deps.globalConfig) {
    await vscode.window.showWarningMessage("VSCodeSync: P2P engine deps не подключены в этом сборке.");
    return;
  }

  const sessionId = await vscode.window.showInputBox({
    prompt: role === "inviter"
      ? "Sessions ID — поделитесь с invitee (любая строка, обе стороны должны ввести одинаково)"
      : "Sessions ID — введите тот, что прислал inviter",
    placeHolder: "e.g. dev-stand-2026-05-09",
    ignoreFocusOut: true,
  });
  if (!sessionId || sessionId.trim().length === 0) return;
  const peerMachineId = await vscode.window.showInputBox({
    prompt: "Peer machine id (target). Найдите в _machines.json другой машины.",
    placeHolder: "machineId",
    ignoreFocusOut: true,
  });
  if (!peerMachineId) return;

  const provider = await deps.tryAuthenticatedProvider();
  if (!provider) {
    await vscode.window.showWarningMessage("VSCodeSync: провайдер не подключён.");
    return;
  }
  const gc = await deps.globalConfig.load();
  const signaling = createSignalingTransport({ provider, workspaceWritable: true });
  // Caller injects a per-session encryption key. For this wiring the key is
  // ephemeral random — both sides must share it via the passkey/passphrase
  // channel. Future iteration: derive from a shared workspace secret.
  const key = randomBytes(32);

  await vscode.window.showInformationMessage(
    `VSCodeSync: P2P key (передайте другой машине — base64): ${key.toString("base64")}`,
    "OK",
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `VSCodeSync · P2P session (${role})…`, cancellable: true },
    async (_p, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => { ac.abort(); });
      const result = await openP2PSession({
        role,
        sessionId: sessionId.trim(),
        myMachineId: gc.machineId,
        peerMachineId: peerMachineId.trim(),
        encryptionKey: key,
        signaling,
        registry: deps.registry,
        abortSignal: ac.signal,
        onSessionEvent: deps.logSyncActivity
          ? (event) => {
              deps.logSyncActivity?.({
                kind: "p2p_session",
                workspaceId: sessionId.trim(),
                workspaceNote: `P2P · ${peerMachineId.trim()}`,
                relPath: "",
                machineName: gc.machineName,
                provider: "onedrive",
                detail: event.kind,
                meta: { eventTsMs: event.tsMs },
              });
            }
          : undefined,
      });
      if (!result.ok) {
        await vscode.window.showWarningMessage(`VSCodeSync: P2P session failed — ${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
        return;
      }
      deps.registry.upsert({
        id: sessionId.trim(),
        snapshot: { state: result.machine.state, transport: "cloud", peerCount: 1, peerLabel: peerMachineId.trim() },
      });
      // v2.12.4 — bind authenticated channel to mirror registry so engine
      // pushFile events fan out over WebRTC alongside cloud upload.
      deps.mirrorRegistry?.bind(sessionId.trim(), null, result.channel);
      await vscode.window.showInformationMessage(
        `VSCodeSync: P2P session ${sessionId.trim()} открыта с ${peerMachineId.trim()}.`,
      );
    },
  );
}

async function runDisconnectP2PSession(deps: P2PSessionCommandsDeps): Promise<void> {
  const primary = deps.registry.primary();
  if (!primary) {
    await vscode.window.showInformationMessage("VSCodeSync: нет активной P2P сессии.");
    return;
  }
  deps.registry.remove(primary.id);
  deps.mirrorRegistry?.unbind(primary.id);
  await vscode.window.showInformationMessage(
    `VSCodeSync: P2P сессия ${primary.id} закрыта.`,
  );
}

async function pickRole(): Promise<P2PSessionRole | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(person-add) Пригласить (Inviter)",
        description: "Сгенерировать offer и ждать ответ от другой машины",
        role: "inviter" as const,
      },
      {
        label: "$(reply) Принять приглашение (Invitee)",
        description: "Сгенерировать answer на полученный offer",
        role: "invitee" as const,
      },
    ],
    { placeHolder: "VSCodeSync · P2P session: выберите роль" },
  );
  return picked?.role;
}

async function showPlanQuickPick(
  steps: readonly P2PSessionStep[],
  warnings: readonly P2PSessionWarning[],
  transport: "cloud" | "qr",
): Promise<void> {
  const items: vscode.QuickPickItem[] = steps.map((s, i) => ({
    label: `${String(i + 1)}. ${describeStep(s)}`,
    description: i === 0 ? `transport: ${transport}` : undefined,
  }));
  for (const w of warnings) {
    items.push({
      label: `$(warning) ${describeWarning(w)}`,
      description: "warning",
    });
  }
  await vscode.window.showQuickPick(items, {
    placeHolder: `Plan (${transport}): ${String(steps.length)} steps`,
    canPickMany: false,
    ignoreFocusOut: true,
  });
}

function describeStep(s: P2PSessionStep): string {
  switch (s) {
    case "pick_role": return "Pick role";
    case "pick_target_machine": return "Pick target machine";
    case "pick_active_session": return "Pick active session";
    case "generate_offer": return "Generate WebRTC offer";
    case "exchange_offer_qr": return "Render offer QR (chunks)";
    case "exchange_answer_qr": return "Scan answer QR";
    case "wait_for_answer": return "Wait for answer (cloud)";
    case "decode_offer_qr": return "Scan offer QR";
    case "generate_answer": return "Generate WebRTC answer";
    case "ice_exchange": return "ICE candidate exchange";
    case "connection_established": return "DataChannel connected";
    case "abort_no_peers": return "Abort: no online peers";
  }
}

function describeWarning(w: P2PSessionWarning): string {
  switch (w) {
    case "no_online_peers": return "no online peers — invitee must come online first";
    case "no_active_invites": return "no active invite found in cloud signaling channel";
    case "qr_oversized_payload": return "QR payload exceeds 4 chunks — split into multiple QR codes";
    case "transport_fallback_to_qr": return "cloud signaling not writable — falling back to QR";
  }
}
