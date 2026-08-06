/**
 * One forced token refresh per 401, then one retry (E1).
 *
 * Expiry-based refresh alone cannot cover a token that the provider revoked
 * server-side: `expiresAtMs` still looks healthy, so every request 401s and the
 * user is stuck. A 401 is the only reliable signal that the credential is dead,
 * so it must be able to trigger a refresh regardless of the stored expiry.
 *
 * The retry happens at most once — if the fresh token also 401s, the grant is
 * gone and the caller must classify it as UNAUTHORIZED and prompt a sign-in.
 */

export interface ForcedRefreshFetchOptions {
  /** Sends the request. Called once, or twice when the first answer is 401. */
  send: (init: RequestInit) => Promise<Response>;
  init: RequestInit;
  /**
   * Forces a token refresh and resolves to the new access token. Throwing here
   * (e.g. `invalid_grant`) propagates: there is nothing left to retry with.
   */
  forceRefresh: () => Promise<string>;
}

export async function sendWithForcedRefreshOn401(
  opts: ForcedRefreshFetchOptions,
): Promise<Response> {
  const first = await opts.send(opts.init);
  if (first.status !== 401) {
    return first;
  }
  const token = await opts.forceRefresh();
  return opts.send(withAuthorization(opts.init, token));
}

/** Copy of `init` with the bearer token replaced; the original is left alone. */
export function withAuthorization(init: RequestInit, accessToken: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}
