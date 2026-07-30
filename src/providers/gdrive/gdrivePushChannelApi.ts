import { CLOUD_ROOT_DIR } from "../../core/cloudLayout.js";
import { decodeGdrivePushChannelEnvelope } from "../../core/gdrivePushChannelResponseDecoder.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const MIME_FOLDER = "application/vnd.google-apps.folder";

function escapeDriveQueryLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Same semantics as GdriveProvider.getRootFolderId — VSCodeSyncFiles under user Drive root. */
export async function getGdriveVsCodeSyncRootFolderId(accessToken: string): Promise<string> {
  const name = escapeDriveQueryLiteral(CLOUD_ROOT_DIR);
  const q = `name='${name}' and 'root' in parents and mimeType='${MIME_FOLDER}' and trashed=false`;
  const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`;
  const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${accessToken}` } }, { channel: "gdrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  if (!r.ok) {
    throw new Error(`Google Drive root list ${String(r.status)}: ${await r.text()}`);
  }
  const j = (await r.json()) as { files?: { id?: string }[] };
  const existing = j.files?.[0]?.id;
  if (existing) {
    return existing;
  }
  const create = await fetchWithTimeout(`${DRIVE}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: CLOUD_ROOT_DIR,
      mimeType: MIME_FOLDER,
      parents: ["root"],
    }),
  }, { channel: "gdrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  if (!create.ok) {
    throw new Error(`Google Drive mkdir root ${String(create.status)}: ${await create.text()}`);
  }
  const created = (await create.json()) as { id?: string };
  if (!created.id) {
    throw new Error("Google Drive: failed to create VSCodeSyncFiles folder");
  }
  return created.id;
}

export interface GdrivePushChannelRecord {
  id: string;
  resourceId: string;
  expiration: string;
}

export async function gdriveStartFolderWatch(
  accessToken: string,
  folderId: string,
  channelId: string,
  webhookAddress: string,
  channelToken: string,
): Promise<GdrivePushChannelRecord> {
  const r = await fetchWithTimeout(`${DRIVE}/files/${encodeURIComponent(folderId)}/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: channelId,
      type: "web_hook",
      address: webhookAddress,
      token: channelToken,
    }),
  }, { channel: "gdrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`Google Drive watch ${String(r.status)}: ${txt}`);
  }
  const decoded = decodeGdrivePushChannelEnvelope(JSON.parse(txt));
  if (!decoded.ok) {
    throw new Error(`Google Drive watch: invalid response (${decoded.reason})`);
  }
  return {
    id: decoded.value.id,
    resourceId: decoded.value.resourceId,
    expiration: decoded.value.expiration,
  };
}

export async function gdriveStopPushChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
): Promise<void> {
  const r = await fetchWithTimeout(`${DRIVE}/channels/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: channelId, resourceId }),
  }, { channel: "gdrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  if (r.status === 204 || r.status === 404) {
    return;
  }
  if (!r.ok) {
    throw new Error(`Google Drive channels/stop ${String(r.status)}: ${await r.text()}`);
  }
}
