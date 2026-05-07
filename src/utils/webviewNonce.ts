/**
 * Cryptographic nonce for VS Code webview Content-Security-Policy.
 *
 * Every panel that ships inline `<script>` must use a nonce-based CSP.
 * Centralised here so the four (and counting) webview panels don't keep
 * copy-pasting `randomBytes(16).toString("base64url")`.
 */
import { randomBytes } from "node:crypto";

export function getWebviewNonce(): string {
  return randomBytes(16).toString("base64url");
}
