import type { SecretStore } from "./types.js";
import { generateEncryptionKey } from "./encryption.js";

const KEY_SECRET = "vscodesync.encryptionKey";

export async function readEncryptionKey(secrets: SecretStore): Promise<Buffer | null> {
  const raw = await secrets.get(KEY_SECRET);
  if (!raw) {
    return null;
  }
  try {
    const buf = Buffer.from(raw, "base64");
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export async function storeEncryptionKey(secrets: SecretStore, key: Buffer): Promise<void> {
  await secrets.store(KEY_SECRET, key.toString("base64"));
}

export async function clearEncryptionKey(secrets: SecretStore): Promise<void> {
  await secrets.delete(KEY_SECRET);
}

export async function ensureEncryptionKey(secrets: SecretStore): Promise<Buffer> {
  const existing = await readEncryptionKey(secrets);
  if (existing) {
    return existing;
  }
  const key = generateEncryptionKey();
  await storeEncryptionKey(secrets, key);
  return key;
}
