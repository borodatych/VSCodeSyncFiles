import {
  decodeGraphRenewExpiration,
  decodeGraphSubscriptionEnvelope,
} from "../../core/graphSubscriptionResponseDecoder.js";
import {
  DEFAULT_API_TIMEOUT_MS,
  fetchWithTimeout,
} from "../_shared/fetchWithTimeout.js";

const GRAPH_SUB = "https://graph.microsoft.com/v1.0/subscriptions";

/** ~48h ahead (Graph caps per tenant/resource; may return shorter expiration). */
const DEFAULT_SUBSCRIPTION_TTL_MS = 48 * 3600 * 1000;

export interface CreatedGraphSubscription {
  id: string;
  expirationDateTime: string;
}

export async function graphCreateDriveRootSubscription(
  accessToken: string,
  notificationUrl: string,
  clientState: string,
): Promise<CreatedGraphSubscription> {
  const expirationDateTime = new Date(Date.now() + DEFAULT_SUBSCRIPTION_TTL_MS).toISOString();
  const r = await fetchWithTimeout(GRAPH_SUB, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "updated",
      notificationUrl,
      resource: "/me/drive/root",
      expirationDateTime,
      clientState,
    }),
  }, { channel: "onedrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`Graph subscription ${String(r.status)}: ${t}`);
  }
  const decoded = decodeGraphSubscriptionEnvelope(JSON.parse(t));
  if (!decoded.ok) {
    throw new Error(`Graph subscription: invalid response (${decoded.reason})`);
  }
  return decoded.value;
}

export async function graphRenewSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<string> {
  const expirationDateTime = new Date(Date.now() + DEFAULT_SUBSCRIPTION_TTL_MS).toISOString();
  const r = await fetchWithTimeout(`${GRAPH_SUB}/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime }),
  }, { channel: "onedrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`Graph subscription renew ${String(r.status)}: ${txt}`);
  }
  const decoded = decodeGraphRenewExpiration(JSON.parse(txt), expirationDateTime);
  if (!decoded.ok) {
    throw new Error(`Graph subscription renew: invalid response (${decoded.reason})`);
  }
  return decoded.expirationDateTime;
}

export async function graphDeleteSubscription(accessToken: string, subscriptionId: string): Promise<void> {
  const r = await fetchWithTimeout(`${GRAPH_SUB}/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  }, { channel: "onedrive.webhook", timeoutMs: DEFAULT_API_TIMEOUT_MS });
  if (r.status === 204 || r.status === 404) {
    return;
  }
  if (!r.ok) {
    throw new Error(`Graph delete subscription ${String(r.status)}: ${await r.text()}`);
  }
}
