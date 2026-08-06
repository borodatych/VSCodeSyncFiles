/**
 * Builds the {@link SnapshotCrypto} context for call sites outside the engine.
 *
 * The engine derives it from its own deps; every other snapshot caller (palette
 * commands, task provider, scheduled snapshots) reads the setting and the key
 * here, so "did this path remember to encrypt?" has a single answer.
 */
import * as vscode from "vscode";
import type { SecretStore } from "../core/types.js";
import { readEncryptionKey } from "../core/encryptionKey.js";
import { encryptBuffer, decryptBuffer } from "../core/encryption.js";
import type { SnapshotCrypto } from "../core/snapshotsEngine.js";

const CFG_SECTION = "vscodesync";

export async function readSnapshotCrypto(secrets: SecretStore): Promise<SnapshotCrypto> {
  const required = vscode.workspace.getConfiguration(CFG_SECTION).get<boolean>("encryption", false);
  const key = await readEncryptionKey(secrets);
  if (key === null) {
    // `required` without a key is not an error here — the snapshot engine
    // refuses, with a message that tells the user to unlock the key.
    return { required };
  }
  return {
    required,
    encrypt: (buf: Buffer) => encryptBuffer(key, buf),
    decrypt: (buf: Buffer) => decryptBuffer(key, buf),
  };
}
