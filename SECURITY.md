# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in **VSCodeSyncFiles**,
please report it privately:

- **Email:** [i@borodatych.ru](mailto:i@borodatych.ru) (use subject prefix `[VSCodeSync security]`)
- Or open a private security advisory on GitHub:
  <https://github.com/borodatych/VSCodeSyncFiles/security/advisories/new>

Please **do not** open public issues for security problems.

We aim to acknowledge reports within 72 hours and to issue a fix or mitigation
within 30 days for critical issues. Coordinated disclosure is preferred.

## Scope

In scope:

- The published VSIX (Marketplace + Open VSX) and its bundled CLI in `cli/`.
- Cloud provider implementations (OneDrive, Google Drive, Dropbox, Yandex.Disk).
- Encryption (`src/core/encryption.ts`, `src/core/encryptionKey.ts`),
  webhook handlers, and OAuth loopback servers.

Out of scope:

- Vulnerabilities in upstream cloud APIs themselves — please report to the
  respective vendor.
- Issues that require a pre-compromised host (e.g. attacker already has shell
  access to the user's machine).

## Trust model

- **Tokens** are stored in VS Code [SecretStorage]
  (https://code.visualstudio.com/api/references/vscode-api#SecretStorage).
  They never appear in `~/.vscode/vscodeSync/config.json`.
- **Encryption key** is stored in SecretStorage; key rotation is a built-in
  command. Without the key the cloud blobs are unreadable.
- The extension performs **PKCE OAuth** on a localhost loopback for every
  provider. No client secret is required.

## Public OAuth client identifiers

The bundled defaults for `vscodesync.dropboxAppKey` and
`vscodesync.yandexOAuthClientId` are *public* OAuth client IDs as required
by their respective desktop OAuth flows. PKCE prevents misuse: an attacker
who only learns the client id cannot exchange an authorisation code without
the user's PKCE verifier. Users may override these with their own client ids.

## Webhook tunnel disclosure

When `vscodesync.webhooks.tunnelEnabled` is `true`, the extension uses
[smee.io](https://smee.io/) to relay webhook payloads from cloud providers
to the local instance. This means:

- Webhook URLs and headers transit a public third-party relay.
- Payload bodies are validated locally (`clientState` / `X-Goog-Channel-Token`)
  before any action is taken.
- If you require self-hosted relays, leave the tunnel disabled and use direct
  port-forwarding or a Cloudflare/Tailscale tunnel.

## Hardening checklist for self-hosters

- Enable encryption (`vscodesync.encryption.enabled: true`).
- Rotate the encryption key periodically (`Rotate Encryption Key` command).
- Keep the extension up to date — security fixes ship in the
  `maintenance` part of the version.
- For corporate environments, set custom OAuth client ids and a dedicated
  cloud account.
