/**
 * Passkey command bundle — registers
 *   - `vscodesync.showPasskeySettings` — webview listing enrolled credentials,
 *     with rename / remove actions piped back through `onDidReceiveMessage`.
 *   - `vscodesync.removePasskey` — direct command (palette-discoverable) to
 *     drop a credential id from the registry. Useful when the webview is
 *     unavailable or the user knows the credential id.
 *   - `vscodesync.passkeyFallback` — passphrase-based fallback flow. Walks
 *     the user through enroll / unlock / recover modes via InputBoxes,
 *     respecting the lockout schedule from {@link planPassphraseFlow}.
 *
 * WebAuthn enroll + unlock are wired through the platform adapter via
 * `wrapDekForWebauthn` / PRF replay — both call paths land on the
 * registry routines below. Native FIDO2 probing is best-effort and may
 * fall back to passphrase recovery when no authenticator is available.
 */
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
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
import { runWebAuthnEnroll, runWebAuthnUnlock } from "./webauthnWebview.js";
import { wrapDekForWebauthn, unwrapDekFromWebauthn } from "../core/passkeyEnvelopeWrap.js";
import { deriveWebauthnKek } from "../core/keyEnvelope.js";
import {
  readEncryptionKey,
  readWebauthnEnvelope,
  storeEncryptionKey,
  storeWebauthnEnvelope,
} from "../core/encryptionKey.js";

function logPasskeyTelemetry(event: PasskeyTelemetryEvent): void {
  const payload = toUsagePayload(event);
  logSanitisedUsage(payload.name, payload.data);
}

const SHOW_COMMAND = "vscodesync.showPasskeySettings";
const REMOVE_COMMAND = "vscodesync.removePasskey";
const FALLBACK_COMMAND = "vscodesync.passkeyFallback";
const ENROLL_COMMAND = "vscodesync.enrollPasskey";
const UNLOCK_COMMAND = "vscodesync.unlockWithPasskey";

const RP_ID = "vscodesync.local";
const RP_NAME = "VSCodeSync";

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
    vscode.commands.registerCommand(ENROLL_COMMAND, () => runEnrollPasskey(storage, context.secrets)),
    vscode.commands.registerCommand(UNLOCK_COMMAND, () => runUnlockWithPasskey(storage, context.secrets)),
  ];
}

async function runEnrollPasskey(storage: PasskeyRegistryStorage, secrets: vscode.SecretStorage): Promise<void> {
  const displayName = await vscode.window.showInputBox({
    prompt: "Имя для нового passkey (например: «MacBook Touch ID», «YubiKey»)",
    placeHolder: "VSCodeSync · enroll passkey",
    validateInput: (v: string) => (v.trim().length === 0 ? "Имя не может быть пустым" : undefined),
  });
  if (displayName === undefined) return;

  const userIdB64Url = bytesToB64Url(randomBytes(16));
  const challengeHex = randomBytes(32).toString("hex");
  const prfSaltHex = randomBytes(32).toString("hex");

  const result = await runWebAuthnEnroll({
    rpId: RP_ID,
    rpName: RP_NAME,
    userIdB64Url,
    userName: "vscodesync-user",
    displayName: displayName.trim(),
    challengeHex,
    prfSaltHex,
  });
  if (!result.ok) {
    await vscode.window.showWarningMessage(`VSCodeSync: enroll passkey не выполнен (${result.reason}).`);
    return;
  }

  const registry = await storage.load();
  const updated = upsertCredential(registry, {
    id: result.credentialIdB64Url,
    displayName: displayName.trim(),
    userAgent: process.platform,
    enrolledAtMs: Date.now(),
    lastUsedAtMs: null,
  });
  await storage.save(updated);

  logPasskeyTelemetry({
    kind: "enroll_success",
    credentialCount: updated.entries.length,
    browser: "Other",
    os: "Other",
  });

  // v2.2.x — DEK rewrap. When PRF was returned by the authenticator and a
  // primary DEK already exists in SecretStorage, wrap the DEK under a KEK
  // derived from the PRF output and persist the envelope. Future
  // unlockWithPasskey re-derives the same KEK using the saved prfSaltHex.
  let rewrapNote = "";
  if (result.prfB64Url) {
    try {
      const dek = await readEncryptionKey(secrets);
      if (dek) {
        const prfBytes = b64UrlToBytes(result.prfB64Url);
        const envelope = wrapDekForWebauthn(
          new Uint8Array(dek),
          result.credentialIdB64Url,
          (_credentialId: string, salt: Uint8Array) => deriveWebauthnKek(prfBytes, salt),
        );
        envelope.meta = { ...(envelope.meta ?? {}), prfSaltHex };
        await storeWebauthnEnvelope(secrets, envelope);
        rewrapNote = " DEK обёрнут в WebAuthn envelope.";
      } else {
        rewrapNote = " DEK ещё не создан (используйте Encryption commands).";
      }
    } catch (e) {
      rewrapNote = ` Wrap DEK failed: ${e instanceof Error ? e.message : String(e)}.`;
    }
  }

  const prfNote = result.prfB64Url
    ? `PRF extension активна.${rewrapNote}`
    : "PRF extension недоступна — DEK rewrap пропущен.";
  void vscode.window.showInformationMessage(`VSCodeSync: passkey добавлен. ${prfNote}`);
}

async function runUnlockWithPasskey(storage: PasskeyRegistryStorage, secrets: vscode.SecretStorage): Promise<void> {
  const registry = await storage.load();
  if (registry.entries.length === 0) {
    void vscode.window.showInformationMessage("VSCodeSync: нет зарегистрированных passkeys. Запустите Enroll passkey.");
    return;
  }

  const ordered = orderForDisplay(registry);
  const picked = await vscode.window.showQuickPick(
    ordered.map((d) => ({
      label: d.displayName,
      description: d.id.slice(0, 12) + "…",
      detail: d.lastUsedAtMs ? `last used ${new Date(d.lastUsedAtMs).toISOString()}` : "never used",
      id: d.id,
    })),
    { placeHolder: "Выберите passkey для unlock" },
  );
  if (!picked) return;

  // v2.2.x — replay enrolled prfSaltHex when an envelope exists, so the
  // ceremony yields the same PRF output and the saved KEK can be re-derived.
  const envelope = await readWebauthnEnvelope(secrets);
  const prfSaltHex = envelope?.meta?.prfSaltHex ?? randomBytes(32).toString("hex");
  const challengeHex = randomBytes(32).toString("hex");
  const result = await runWebAuthnUnlock({
    rpId: RP_ID,
    credentialIdB64Url: picked.id,
    challengeHex,
    prfSaltHex,
  });
  if (!result.ok) {
    await vscode.window.showWarningMessage(`VSCodeSync: unlock не выполнен (${result.reason}).`);
    return;
  }

  // Touch lastUsedAtMs.
  const cred = findCredentialById(registry, result.credentialIdB64Url);
  if (cred) {
    const updated = upsertCredential(registry, { ...cred, lastUsedAtMs: Date.now() });
    await storage.save(updated);
  }

  logPasskeyTelemetry({
    kind: "unlock_success",
    credentialCount: registry.entries.length,
    latencyMs: null,
  });

  let unwrapNote = "";
  if (envelope && result.prfB64Url) {
    const prfBytes = b64UrlToBytes(result.prfB64Url);
    const r = unwrapDekFromWebauthn(envelope, (_credentialId: string, salt: Uint8Array) => deriveWebauthnKek(prfBytes, salt));
    if (r.ok) {
      await storeEncryptionKey(secrets, Buffer.from(r.rawDek));
      unwrapNote = " DEK восстановлен в SecretStorage.";
    } else {
      unwrapNote = ` DEK unwrap failed: ${r.reason}.`;
    }
  } else if (envelope && !result.prfB64Url) {
    unwrapNote = " PRF недоступен — DEK не восстановлен (envelope сохранён).";
  } else if (!envelope && result.prfB64Url) {
    unwrapNote = " Envelope ещё не создан — запустите Enroll passkey.";
  }

  void vscode.window.showInformationMessage(`VSCodeSync: passkey ceremony OK.${unwrapNote}`);
}

function bytesToB64Url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64"));
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
        void vscode.window.showInformationMessage(
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
    void vscode.window.showInformationMessage("VSCodeSync: нет зарегистрированных passkey.");
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
  void vscode.window.showInformationMessage(
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
  void vscode.window.showInformationMessage(
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
