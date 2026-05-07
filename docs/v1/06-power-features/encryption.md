# Шифрование (E2E)

> Опциональное end-to-end шифрование файлов на облаке. AES-256-GCM, ключ в keychain.

**Часть фазы:** [06-power-features](roadmap.md)  
**Реализация:** `src/core/encryption.ts`, `src/core/encryptionKey.ts`

---

## Включение

- [x] `vscodesync.encryption: true` в настройках
- [x] При первом включении: генерировать ключ AES-256, сохранить в `vscode.SecretStorage`, показать уведомление с кнопкой экспорта (extension.ts `encryptionKey.ts`)

---

## Реализация шифрования

- [x] Desktop: `node:crypto` AES-256-GCM
  - `crypto.randomBytes(12)` → IV
  - `crypto.createCipheriv('aes-256-gcm', key, iv)`
  - Формат: `IV (12 bytes) || CipherText || AuthTag (16 bytes)`
- [x] Шифровать после compress (перед upload)
- [x] Web extension: `SubtleCrypto` AES-GCM — реализовано в `src/core/platformCrypto.ts.createWebCrypto()`; cross-impl roundtrip покрыт `tests/unit/platformCrypto.test.ts`.

---

## Экспорт/импорт ключа

- [x] `VSCodeSync: Export Encryption Key`: password → PBKDF2 → AES-256-GCM → `.vscodesync-key.enc`
- [x] `VSCodeSync: Import Encryption Key`: читать `.enc`, вводить пароль, сохранять в keychain
- [x] `VSCodeSync: Rotate Encryption Key` — полная реализация:
  1. Авто-снапшот `auto-pre-key-rotation-{date}` для всех workspace
  2. Генерация нового ключа `generateEncryptionKey()`
  3. Перешифровка каждого облачного blob: download → `decryptBuffer(oldKey)` → `encryptBuffer(newKey)` → upload
  4. Сохранение нового ключа в SecretStorage
  5. Progress notification + предложение экспортировать новый ключ

---

## Потеря ключа (`VSCodeSync: Purge Encrypted Workspace...`)

- [x] Удалить workspace с облака (`deleteWorkspaceFromCloud`); команда доступна при включённом шифровании

---

## SecretStorage

- [x] VSCode ≥ 1.80: нативный `vscode.SecretStorage` (всегда в v1 с engine `^1.80`)

---

## Workspace-конфиг не содержит токенов

- [x] `.vscode/vscodesync.json` не содержит токены/ключи — безопасно коммитить
