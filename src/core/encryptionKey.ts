import type { SecretStore } from "./types.js";
import { generateEncryptionKey } from "./encryption.js";
import { isKeyEnvelope, type KeyEnvelope } from "./keyEnvelope.js";

const KEY_SECRET = "vscodesync.encryptionKey";
const WEBAUTHN_ENVELOPE_SECRET = "vscodesync.encryptionKey.webauthnEnvelope";

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

// v2.2.x — WebAuthn-wrapped DEK envelope (opt-in second factor).
// The envelope stores the DEK encrypted under a KEK derived from a
// passkey PRF output. `enrollPasskey` writes it; `unlockWithPasskey`
// reads it and uses the PRF salt in `meta.prfSaltHex` to replay the
// authenticator ceremony.

export async function readWebauthnEnvelope(secrets: SecretStore): Promise<KeyEnvelope | null> {
  const raw = await secrets.get(WEBAUTHN_ENVELOPE_SECRET);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return isKeyEnvelope(parsed) ? parsed : null;
}

export async function storeWebauthnEnvelope(secrets: SecretStore, envelope: KeyEnvelope): Promise<void> {
  await secrets.store(WEBAUTHN_ENVELOPE_SECRET, JSON.stringify(envelope));
}

export async function clearWebauthnEnvelope(secrets: SecretStore): Promise<void> {
  await secrets.delete(WEBAUTHN_ENVELOPE_SECRET);
}
