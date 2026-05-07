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
  const r = await fetch(GRAPH_SUB, {
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
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`Graph subscription ${String(r.status)}: ${t}`);
  }
  const j = JSON.parse(t) as { id?: string; expirationDateTime?: string };
  if (!j.id || !j.expirationDateTime) {
    throw new Error("Graph subscription: missing id or expirationDateTime in response");
  }
  return { id: j.id, expirationDateTime: j.expirationDateTime };
}

export async function graphRenewSubscription(
  accessToken: string,
  subscriptionId: string,
): Promise<string> {
  const expirationDateTime = new Date(Date.now() + DEFAULT_SUBSCRIPTION_TTL_MS).toISOString();
  const r = await fetch(`${GRAPH_SUB}/${encodeURIComponent(subscriptionId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime }),
  });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`Graph subscription renew ${String(r.status)}: ${txt}`);
  }
  const j = JSON.parse(txt) as { expirationDateTime?: string };
  return j.expirationDateTime ?? expirationDateTime;
}

export async function graphDeleteSubscription(accessToken: string, subscriptionId: string): Promise<void> {
  const r = await fetch(`${GRAPH_SUB}/${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (r.status === 204 || r.status === 404) {
    return;
  }
  if (!r.ok) {
    throw new Error(`Graph delete subscription ${String(r.status)}: ${await r.text()}`);
  }
}
