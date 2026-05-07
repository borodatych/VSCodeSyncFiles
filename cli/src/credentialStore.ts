import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { SecretStore } from "../../src/core/types.js";

const DEFAULT_CREDS_FILE = path.join(os.homedir(), ".vscode", "vscodeSync", "cli-credentials.json");
/** keytar service name registered in the system keychain. */
const KEYTAR_SERVICE = "vscodesync-cli";

export function getDefaultCredentialsPath(): string {
  return DEFAULT_CREDS_FILE;
}

// ─── System keychain via keytar ───────────────────────────────────────────────

interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/**
 * Attempt to load `keytar` (optional native module).
 * Returns null when keytar is not installed or not functional on this platform.
 */
async function tryLoadKeytar(): Promise<KeytarApi | null> {
  try {
    // Dynamic import so the CLI bundle doesn't fail when keytar is absent.
     
    const mod = await import("keytar");
     
    const api = mod as unknown as KeytarApi;
    if (typeof api.getPassword !== "function") return null;
    return api;
  } catch {
    return null;
  }
}

/**
 * System-keychain-backed SecretStore (macOS Keychain, Windows Credential Manager, libsecret on Linux).
 * Falls back to `null` when keytar is unavailable; caller should use file-based store instead.
 */
export async function createKeytarSecretStore(): Promise<SecretStore | null> {
  const keytar = await tryLoadKeytar();
  if (!keytar) return null;

  return {
    async get(key: string): Promise<string | undefined> {
      const val = await keytar.getPassword(KEYTAR_SERVICE, key);
      return val ?? undefined;
    },
    async store(key: string, value: string): Promise<void> {
      await keytar.setPassword(KEYTAR_SERVICE, key, value);
    },
    async delete(key: string): Promise<void> {
      await keytar.deletePassword(KEYTAR_SERVICE, key);
    },
  };
}

/**
 * File-backed SecretStore for CLI use. Persists to `~/.vscode/vscodeSync/cli-credentials.json`.
 * Sets chmod 0o600 after writes (ignored on Windows if unsupported).
 */
export function createFileSecretStore(filePath = DEFAULT_CREDS_FILE): SecretStore {
  let cache: Record<string, string> | null = null;

  const load = async (): Promise<Record<string, string>> => {
    if (cache !== null) {
      return cache;
    }
    try {
      const raw = await fs.readFile(filePath, "utf8");
      cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      cache = {};
    }
    return cache;
  };

  const persist = async (data: Record<string, string>): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      /* chmod not supported on Windows — acceptable */
    }
    cache = data;
  };

  return {
    async get(key: string): Promise<string | undefined> {
      const data = await load();
      return data[key];
    },
    async store(key: string, value: string): Promise<void> {
      const data = await load();
      data[key] = value;
      await persist(data);
    },
    async delete(key: string): Promise<void> {
      const data = await load();
      const { [key]: _removed, ...rest } = data;
      await persist(rest);
    },
  };
}

/** True when cli-credentials.json exists and contains data for the given key. */
export async function hasFileCredential(key: string, filePath = DEFAULT_CREDS_FILE): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(data, key) && data[key] !== undefined;
  } catch {
    return false;
  }
}
