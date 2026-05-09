/**
 * v2.20.3 — bridges existing per-provider client IDs (from settings) to the
 * generic OAuth Device Code command.
 */
import * as vscode from "vscode";
import { storeOneDriveTokens } from "../providers/onedrive/onedriveProvider.js";
import { storeGdriveTokens } from "../providers/gdrive/gdriveTokens.js";

export interface DeviceCodeProviderEntry {
  readonly id: "onedrive" | "gdrive";
  readonly label: string;
  readonly clientId: string;
  readonly deviceAuthEndpoint: string;
  readonly tokenEndpoint: string;
  readonly scope: string;
  storeTokens: (t: { accessToken: string; refreshToken?: string }) => Promise<boolean>;
}

export function resolveDeviceCodeProviders(
  context: vscode.ExtensionContext,
): DeviceCodeProviderEntry[] {
  const cfg = vscode.workspace.getConfiguration("vscodesync");
  const out: DeviceCodeProviderEntry[] = [];
  const odCid = cfg.get<string>("onedriveClientId", "").trim();
  if (odCid.length > 0) {
    out.push({
      id: "onedrive",
      label: "OneDrive",
      clientId: odCid,
      deviceAuthEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
      tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      scope: "Files.ReadWrite.All offline_access",
      storeTokens: async (t) => {
        await storeOneDriveTokens(context.secrets, {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAtMs: Date.now() + 3600_000,
          clientId: odCid,
        });
        return true;
      },
    });
  }
  const gdCid = cfg.get<string>("googleDriveClientId", "").trim();
  if (gdCid.length > 0) {
    out.push({
      id: "gdrive",
      label: "Google Drive",
      clientId: gdCid,
      // RFC 8628 endpoints for installed-app client type. Google's web-app
      // client type doesn't expose device-code; the user must register an
      // OAuth client of type "TVs and Limited Input devices" for this to work.
      deviceAuthEndpoint: "https://oauth2.googleapis.com/device/code",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/drive.file",
      storeTokens: async (t) => {
        await storeGdriveTokens(context.secrets, {
          accessToken: t.accessToken,
          refreshToken: t.refreshToken,
          expiresAtMs: Date.now() + 3600_000,
        });
        return true;
      },
    });
  }
  return out;
}
