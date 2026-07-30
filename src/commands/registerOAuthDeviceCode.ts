/**
 * v2.20.3 — RFC 8628 OAuth Device Authorization flow UI command.
 *
 * `vscodesync.signInDeviceCode` walks the user through:
 *   1. Pick provider (OneDrive / Google Drive — only providers with public
 *      device endpoints).
 *   2. POST to the device-auth endpoint, parse via `parseDeviceAuthResponse`.
 *   3. Show the user-code + verification URI in a modal info-message.
 *   4. Poll the token endpoint at `interval` seconds; route each response
 *      through `planDeviceCodePoll` for slow_down / expired_token / pending.
 *   5. On `ok` event — caller stores the access/refresh tokens via the
 *      provider's existing token-bundle helper.
 *
 * Headless / CI / vscode.dev path: `navigator.clipboard` is best-effort, the
 * primary UX is the toast. `vscode.env.openExternal` opens the verification
 * URI in the user's browser when available.
 */
import * as vscode from "vscode";
import {
  DEFAULT_API_TIMEOUT_MS,
  fetchWithTimeout,
} from "../providers/_shared/fetchWithTimeout.js";
import {
  parseDeviceAuthResponse,
  planDeviceCodePoll,
  type DeviceAuthResponse,
  type DeviceCodePollEvent,
} from "../core/oauthDeviceCodeFlow.js";

interface DeviceCodeProvider {
  readonly id: "onedrive" | "gdrive";
  readonly label: string;
  readonly clientId: string;
  readonly deviceAuthEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scope: string;
  /** Caller persists the resulting tokens. Returns `true` on successful save. */
  storeTokens: (tokens: { accessToken: string; refreshToken?: string }) => Promise<boolean>;
}

export interface OAuthDeviceCodeDeps {
  context: vscode.ExtensionContext;
  /** Resolves an array of providers that support device-code sign-in. UI
   * pick is rendered from this list; an empty array surfaces a clear
   * "no providers configured" message. */
  resolveProviders: () => DeviceCodeProvider[];
}

const COMMAND_ID = "vscodesync.signInDeviceCode";

export function registerOAuthDeviceCodeCommand(
  deps: OAuthDeviceCodeDeps,
): vscode.Disposable[] {
  return [vscode.commands.registerCommand(COMMAND_ID, () => runSignInDeviceCode(deps))];
}

async function runSignInDeviceCode(deps: OAuthDeviceCodeDeps): Promise<void> {
  const providers = deps.resolveProviders();
  if (providers.length === 0) {
    void vscode.window.showInformationMessage(
      "VSCodeSync: device-code sign-in пока не сконфигурирован для этого билда (нет clientId).",
    );
    return;
  }

  const picked = providers.length === 1
    ? providers[0]
    : await vscode.window.showQuickPick(
        providers.map((p) => ({ label: p.label, id: p.id, provider: p })),
        { placeHolder: "Выберите провайдер для device-code sign-in" },
      ).then((p) => (p ? p.provider : undefined));
  if (!picked) return;

  let device: DeviceAuthResponse;
  try {
    const body = new URLSearchParams({ client_id: picked.clientId, scope: picked.scope });
    const res = await fetchWithTimeout(picked.deviceAuthEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body: body.toString(),
    }, { channel: "oauth.deviceCode", timeoutMs: DEFAULT_API_TIMEOUT_MS });
    const raw: unknown = await res.json();
    const parsed = parseDeviceAuthResponse(raw, Date.now());
    if (!parsed.ok) {
      await vscode.window.showWarningMessage(`VSCodeSync: device-auth response rejected (${parsed.reason}).`);
      return;
    }
    device = parsed.value;
  } catch (e) {
    await vscode.window.showWarningMessage(
      `VSCodeSync: device-auth request failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  const verificationUri = device.verificationUriComplete ?? device.verificationUri;
  const userMsg = `VSCodeSync: откройте ${verificationUri} и введите код ${device.userCode}.`;
  const choice = await vscode.window.showInformationMessage(userMsg, "Открыть в браузере", "Скопировать код");
  if (choice === "Открыть в браузере") {
    await vscode.env.openExternal(vscode.Uri.parse(verificationUri));
  } else if (choice === "Скопировать код") {
    await vscode.env.clipboard.writeText(device.userCode);
  }

  const tokens = await pollForTokens(picked, device);
  if (!tokens) return;

  const stored = await picked.storeTokens(tokens);
  if (stored) {
    void vscode.window.showInformationMessage(`VSCodeSync: вход через device-code (${picked.label}) выполнен.`);
  } else {
    await vscode.window.showWarningMessage("VSCodeSync: токены получены, но провайдер отклонил их сохранение.");
  }
}

async function pollForTokens(
  provider: DeviceCodeProvider,
  device: DeviceAuthResponse,
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  let currentDelayMs = device.intervalMs;
  let consecutiveSlowDowns = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, currentDelayMs));
    if (Date.now() >= device.expiresAtMs) return null;

    let event: DeviceCodePollEvent;
    try {
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: provider.clientId,
      });
      const res = await fetchWithTimeout(provider.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: body.toString(),
      }, { channel: "oauth.deviceCode", timeoutMs: DEFAULT_API_TIMEOUT_MS });
      const json = (await res.json()) as Record<string, unknown>;
      if (typeof json.access_token === "string") {
        event = {
          kind: "ok",
          accessToken: json.access_token,
          refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
        };
      } else if (json.error === "authorization_pending") {
        event = { kind: "authorization_pending" };
      } else if (json.error === "slow_down") {
        event = { kind: "slow_down" };
      } else if (json.error === "expired_token") {
        event = { kind: "expired_token" };
      } else if (json.error === "access_denied") {
        event = { kind: "access_denied" };
      } else {
        event = { kind: "unknown_error", error: typeof json.error === "string" ? json.error : "no_error_field" };
      }
    } catch (e) {
      event = { kind: "unknown_error", error: e instanceof Error ? e.message : String(e) };
    }

    const decision = planDeviceCodePoll(
      { event, currentDelayMs, consecutiveSlowDowns, nowMs: Date.now(), expiresAtMs: device.expiresAtMs },
      { baseDelayMs: device.intervalMs },
    );

    if (event.kind === "slow_down") consecutiveSlowDowns += 1;
    else consecutiveSlowDowns = 0;

    if (decision.action === "stop") {
      if (decision.reason === "ok" && event.kind === "ok") {
        return { accessToken: event.accessToken, refreshToken: event.refreshToken };
      }
      return null;
    }
    currentDelayMs = decision.delayMs;
  }
}
