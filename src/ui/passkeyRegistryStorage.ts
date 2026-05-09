/**
 * Passkey credential registry persistence — round-trip layer over
 * `vscode.SecretStorage` (v2.2.4 wiring).
 *
 * The pure registry shape lives in
 * {@link PasskeyCredentialRegistry}; this thin wrapper handles JSON
 * serialisation, decoder rejection paths, and a forward-compat fallback
 * (malformed payload → empty registry, with a warn log so the user is not
 * silently re-enrolling).
 *
 * Storage choice: `SecretStorage` rather than `globalState`, because the
 * credential id is enough for an attacker (combined with the device) to
 * bypass the second factor on a sibling browser session. Treat as secret.
 */
import type { ExtensionContext } from "vscode";
import {
  emptyPasskeyRegistry,
  parsePasskeyRegistry,
  type PasskeyCredentialRegistry,
} from "../core/passkeyCredentialRegistry.js";
import { warnLog } from "../utils/log.js";

const SECRET_KEY = "vscodesync.passkey.registry";

export class PasskeyRegistryStorage {
  constructor(private readonly context: ExtensionContext) {}

  async load(): Promise<PasskeyCredentialRegistry> {
    const raw = await this.context.secrets.get(SECRET_KEY);
    if (raw === undefined || raw.length === 0) {
      return emptyPasskeyRegistry();
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (e) {
      warnLog("passkey", `registry payload is not JSON, treating as empty: ${e instanceof Error ? e.message : String(e)}`);
      return emptyPasskeyRegistry();
    }
    const decoded = parsePasskeyRegistry(parsedJson);
    if (!decoded.ok) {
      warnLog("passkey", `registry payload rejected (${decoded.reason}); treating as empty.`);
      return emptyPasskeyRegistry();
    }
    return decoded.registry;
  }

  async save(registry: PasskeyCredentialRegistry): Promise<void> {
    await this.context.secrets.store(SECRET_KEY, JSON.stringify(registry));
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
  }
}
