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
import {
  planP2PSessionWizard,
  type P2PSessionRole,
  type P2PSessionStep,
  type P2PSessionWarning,
} from "../core/p2pSessionWizardSteps.js";
import type { P2PSessionRegistry } from "../core/p2pSessionRegistry.js";

const CFG = "vscodesync";

export interface P2PSessionCommandsDeps {
  context: vscode.ExtensionContext;
  registry: P2PSessionRegistry;
}

export function registerP2PSessionCommands(deps: P2PSessionCommandsDeps): vscode.Disposable[] {
  const { context, registry } = deps;
  void context;

  return [
    vscode.commands.registerCommand("vscodesync.startP2PSession", () => runStartP2PSession(registry)),
    vscode.commands.registerCommand("vscodesync.disconnectP2PSession", () => runDisconnectP2PSession(registry)),
  ];
}

async function runStartP2PSession(_registry: P2PSessionRegistry): Promise<void> {
  void _registry;

  const role = await pickRole();
  if (role === undefined) return;

  const cfg = vscode.workspace.getConfiguration(CFG);
  const experimentalEnabled = cfg.get<boolean>("p2p.experimental", false);

  // First call: pessimistic estimate so the user always sees the wizard plan
  // even before signaling discovery. Real numbers are filled when the
  // experimental path is enabled.
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
      "(`vscodesync.p2p.experimental`) и повторите попытку. Полный DataChannel + " +
      "file-transfer поверх @roamhq/wrtc + qrcode-terminal — следующая итерация.",
      "Открыть настройки",
      "Отмена",
    );
    if (choice === "Открыть настройки") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "vscodesync.p2p.experimental",
      );
    }
    return;
  }

  await vscode.window.showWarningMessage(
    "VSCodeSync: experimental P2P session wiring пока возвращает план без открытия DataChannel. " +
    "Реальный signaling round-trip + WebRTC peer connection — отдельная итерация (см. v2.12.4 в roadmap).",
  );
}

async function runDisconnectP2PSession(registry: P2PSessionRegistry): Promise<void> {
  const primary = registry.primary();
  if (!primary) {
    await vscode.window.showInformationMessage("VSCodeSync: нет активной P2P сессии.");
    return;
  }
  registry.remove(primary.id);
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
