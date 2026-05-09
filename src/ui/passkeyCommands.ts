/**
 * Passkey command bundle (v2.2 wiring) — registers
 *   - `vscodesync.showPasskeySettings` — webview listing enrolled credentials,
 *     with rename / remove actions piped back through `onDidReceiveMessage`.
 *   - `vscodesync.removePasskey` — direct command (palette-discoverable) to
 *     drop a credential id from the registry. Useful when the webview is
 *     unavailable or the user knows the credential id.
 *   - `vscodesync.passkeyFallback` — passphrase-based fallback flow. Walks
 *     the user through enroll / unlock / recover modes via InputBoxes,
 *     respecting the lockout schedule from {@link planPassphraseFlow}.
 *
 * The actual WebAuthn `navigator.credentials` calls are not implemented in
 * this iteration (they require a Chromium-backed webview surface). The
 * commands operate on the credential registry only — enroll / unlock paths
 * surface a "not yet implemented" message so the wiring is honest.
 */
import * as vscode from "vscode";
import {
  findCredentialById,
  orderForDisplay,
  removeCredential,
  upsertCredential,
} from "../core/passkeyCredentialRegistry.js";
import { renderPasskeyDevicesHtml } from "../core/passkeyDevicesFormatter.js";
import {
  planPassphraseFlow,
  type PassphraseFlowMode,
  type PassphraseFlowPlan,
} from "../core/passphraseFallbackFlow.js";
import {
  toUsagePayload,
  type PasskeyTelemetryEvent,
} from "../core/passkeyTelemetryEvents.js";
import { PasskeyRegistryStorage } from "./passkeyRegistryStorage.js";
import { logSanitisedUsage } from "../telemetry/extensionTelemetry.js";

function logPasskeyTelemetry(event: PasskeyTelemetryEvent): void {
  const payload = toUsagePayload(event);
  logSanitisedUsage(payload.name, payload.data);
}

const SHOW_COMMAND = "vscodesync.showPasskeySettings";
const REMOVE_COMMAND = "vscodesync.removePasskey";
const FALLBACK_COMMAND = "vscodesync.passkeyFallback";

export interface PasskeyCommandsDeps {
  context: vscode.ExtensionContext;
}

export function registerPasskeyCommands(deps: PasskeyCommandsDeps): vscode.Disposable[] {
  const { context } = deps;
  const storage = new PasskeyRegistryStorage(context);

  return [
    vscode.commands.registerCommand(SHOW_COMMAND, () => runShowPasskeySettings(context, storage)),
    vscode.commands.registerCommand(REMOVE_COMMAND, () => runRemovePasskey(storage)),
    vscode.commands.registerCommand(FALLBACK_COMMAND, () => runPassphraseFallback()),
  ];
}

async function runShowPasskeySettings(
  context: vscode.ExtensionContext,
  storage: PasskeyRegistryStorage,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "vscodesync.passkeySettings",
    "VSCodeSync · Passkey Settings",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  context.subscriptions.push(panel);

  const refresh = async (): Promise<void> => {
    const registry = await storage.load();
    panel.webview.html = renderPasskeyDevicesHtml(orderForDisplay(registry));
  };

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    void (async () => {
      const action = decodeAction(msg);
      if (!action) return;
      const registry = await storage.load();
      if (action.kind === "remove") {
        await storage.save(removeCredential(registry, action.id));
        await vscode.window.showInformationMessage(
          `VSCodeSync: passkey ${action.id.slice(0, 8)}… removed.`,
        );
      } else {
        const existing = findCredentialById(registry, action.id);
        if (!existing) {
          await vscode.window.showWarningMessage(
            `VSCodeSync: passkey ${action.id.slice(0, 8)}… не найден в реестре.`,
          );
        } else {
          const newName = await vscode.window.showInputBox({
            prompt: "VSCodeSync · Rename passkey",
            value: existing.displayName,
            placeHolder: "Display name",
          });
          if (newName !== undefined && newName.length > 0) {
            await storage.save(
              upsertCredential(registry, { ...existing, displayName: newName }),
            );
          }
        }
      }
      await refresh();
    })();
  });

  await refresh();
}

async function runRemovePasskey(storage: PasskeyRegistryStorage): Promise<void> {
  const registry = await storage.load();
  const ordered = orderForDisplay(registry);
  if (ordered.length === 0) {
    await vscode.window.showInformationMessage("VSCodeSync: нет зарегистрированных passkey.");
    return;
  }
  const picked = await vscode.window.showQuickPick(
    ordered.map((d) => ({
      label: `$(key) ${d.displayName}`,
      description: `${d.id.slice(0, 8)}… · enrolled ${new Date(d.enrolledAtMs).toLocaleDateString()}`,
      id: d.id,
    })),
    { placeHolder: "VSCodeSync · Удалить passkey" },
  );
  if (!picked) return;
  const confirm = await vscode.window.showWarningMessage(
    `VSCodeSync: удалить passkey «${picked.label}»? DEK останется wrapped — нужен fallback passphrase или другой enrolled passkey.`,
    { modal: true },
    "Удалить",
  );
  if (confirm !== "Удалить") return;
  const before = registry.entries.length;
  const wasPrimary = registry.primaryId === picked.id;
  const after = removeCredential(registry, picked.id);
  await storage.save(after);
  logPasskeyTelemetry({
    kind: "removal",
    credentialCount: Math.max(0, before - 1),
    removedPrimary: wasPrimary,
  });
  await vscode.window.showInformationMessage(
    `VSCodeSync: passkey ${picked.id.slice(0, 8)}… удалён.`,
  );
}

async function runPassphraseFallback(): Promise<void> {
  const mode = await pickFallbackMode();
  if (mode === undefined) return;
  // Pessimistic input — full enroll/lockout state lives in SecretStorage and
  // would need a separate persistence layer (out of scope for this wiring).
  // The wizard plan still surfaces the relevant warnings deterministically.
  const plan = planPassphraseFlow({
    mode,
    hasEnrolledPassphrase: false,
    nowMs: Date.now(),
  });
  await showPassphrasePlan(plan);
  logPasskeyTelemetry({
    kind: "passphrase_fallback_used",
    mode,
    attemptsInWindow: 0,
  });
  await vscode.window.showInformationMessage(
    "VSCodeSync: passphrase fallback wiring шипит план шагов; реальная enroll/unlock реализация — следующая итерация (gated behind WebAuthn deriveWebauthnKek).",
  );
}

async function pickFallbackMode(): Promise<PassphraseFlowMode | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(plus) Enroll passphrase", mode: "enroll" as const },
      { label: "$(unlock) Unlock with passphrase", mode: "unlock" as const },
      { label: "$(history) Recover with codes", mode: "recover" as const },
    ],
    { placeHolder: "VSCodeSync · Passphrase fallback" },
  );
  return picked?.mode;
}

async function showPassphrasePlan(plan: PassphraseFlowPlan): Promise<void> {
  const items: vscode.QuickPickItem[] = plan.steps.map((s, i) => ({
    label: `${String(i + 1)}. ${s}`,
  }));
  for (const w of plan.warnings) {
    items.push({ label: `$(warning) ${w}`, description: "warning" });
  }
  await vscode.window.showQuickPick(items, {
    placeHolder: `${plan.mode} plan: ${String(plan.steps.length)} steps`,
    canPickMany: false,
    ignoreFocusOut: true,
  });
}

interface RegistryAction {
  kind: "remove" | "rename";
  id: string;
}

function decodeAction(input: unknown): RegistryAction | null {
  if (input === null || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.action !== "string") return null;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  if (obj.action === "remove" || obj.action === "rename") {
    return { kind: obj.action, id: obj.id };
  }
  return null;
}
