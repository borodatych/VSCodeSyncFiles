import * as path from "node:path";
import * as os from "node:os";
import type { SecretStore } from "../../src/core/types.js";
import { createFileSecretStore, createKeytarSecretStore, hasFileCredential } from "./credentialStore.js";

/** Same JSON shape as stored by desktop extension for OneDrive (`onedriveProvider`). */
const ONEDRIVE_TOKEN_KEY = "vscodesync.onedrive.oauth";

const DEFAULT_CREDS_FILE = path.join(os.homedir(), ".vscode", "vscodeSync", "cli-credentials.json");

interface TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

function bundleFromEnv(override?: string): TokenBundle | null {
  const trimmedOverride = override?.trim();
  const trimmedEnv = process.env.VSCODESYNC_TOKEN?.trim();
  const raw =
    trimmedOverride !== undefined && trimmedOverride.length > 0
      ? trimmedOverride
      : trimmedEnv;
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  return {
    accessToken: raw,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
}

/** Plain bearer: `overrideToken` или `VSCODESYNC_TOKEN` → OneDrive SecretStorage-compatible JSON. */
export function createEnvSecretStore(overrideToken?: string): SecretStore {
  const bundle = bundleFromEnv(overrideToken);
  const map = new Map<string, string>();
  if (bundle) {
    map.set(ONEDRIVE_TOKEN_KEY, JSON.stringify(bundle));
  }
  return {
    get(key: string): Promise<string | undefined> {
      return Promise.resolve(map.get(key));
    },
    store(key: string, value: string): Promise<void> {
      map.set(key, value);
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

export function hasEnvBearer(overrideToken?: string): boolean {
  return bundleFromEnv(overrideToken) !== null;
}

/**
 * Creates a SecretStore that checks (in order):
 * 1. explicit `overrideToken` / `VSCODESYNC_TOKEN` env var
 * 2. System keychain via keytar (if installed)
 * 3. `~/.vscode/vscodeSync/cli-credentials.json` (written by `auth --device-code`)
 */
export async function createAutoSecretStoreAsync(overrideToken?: string): Promise<SecretStore> {
  const envBundle = bundleFromEnv(overrideToken);
  if (envBundle !== null) {
    return createEnvSecretStore(overrideToken);
  }
  const keytarStore = await createKeytarSecretStore();
  if (keytarStore) {
    // Wrap keytar store: fall back to file store for keys not found in keychain
    const fileStore = createFileSecretStore(DEFAULT_CREDS_FILE);
    return {
      async get(key: string): Promise<string | undefined> {
        const fromKeytar = await keytarStore.get(key);
        if (fromKeytar !== undefined) return fromKeytar;
        return fileStore.get(key);
      },
      async store(key: string, value: string): Promise<void> {
        // Write to keychain primarily; also update file as backup
        await keytarStore.store(key, value);
        try {
          await fileStore.store(key, value);
        } catch {
          /* fall back silently */
        }
      },
      async delete(key: string): Promise<void> {
        await keytarStore.delete(key);
        try {
          await fileStore.delete(key);
        } catch {
          /* fall back silently */
        }
      },
    };
  }
  return createFileSecretStore(DEFAULT_CREDS_FILE);
}

/** Synchronous fallback for callers that haven't migrated to the async version. */
export function createAutoSecretStore(overrideToken?: string): SecretStore {
  const envBundle = bundleFromEnv(overrideToken);
  if (envBundle !== null) {
    return createEnvSecretStore(overrideToken);
  }
  return createFileSecretStore(DEFAULT_CREDS_FILE);
}

/**
 * True when a token is available from env var OR from the credentials file OR keychain.
 */
export async function hasAnyCredentials(overrideToken?: string): Promise<boolean> {
  if (hasEnvBearer(overrideToken)) {
    return true;
  }
  // Check keychain
  try {
    const keytarStore = await createKeytarSecretStore();
    if (keytarStore) {
      const val = await keytarStore.get(ONEDRIVE_TOKEN_KEY);
      if (val !== undefined) return true;
    }
  } catch {
    /* keytar unavailable */
  }
  return hasFileCredential(ONEDRIVE_TOKEN_KEY, DEFAULT_CREDS_FILE);
}
