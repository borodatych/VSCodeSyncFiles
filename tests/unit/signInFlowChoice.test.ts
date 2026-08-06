/**
 * Оба способа входа доступны для всех четырёх провайдеров (E13).
 *
 * OneDrive и Google Drive умели только Device Code — вход требовал вручную
 * перенести код на страницу подтверждения, хотя PKCE-модули были написаны и
 * не вызывались ниоткуда. Теперь браузерный вход идёт первым, код устройства
 * остаётся для SSH / контейнеров.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ONEDRIVE_PKCE_REDIRECT_URI,
  ONEDRIVE_PKCE_REDIRECT_PORT,
} from "../../src/providers/onedrive/onedrivePkceOAuth.js";
import {
  GDRIVE_PKCE_REDIRECT_URI,
  GDRIVE_PKCE_REDIRECT_PORT,
} from "../../src/providers/gdrive/gdrivePkceOAuth.js";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("PKCE-вход подключён", () => {
  it("оба потока экспортируются из providerAuthFlows", () => {
    const src = read("src/auth/providerAuthFlows.ts");
    expect(src).toContain("oneDrivePkce");
    expect(src).toContain("googleDrivePkce");
    expect(src).toContain("runOneDrivePkceOAuth");
    expect(src).toContain("runGdrivePkceOAuth");
  });

  it("в QuickPick браузерный вход идёт раньше кода устройства", () => {
    const src = read("src/commands/registerProviderSignIn.ts");
    const browser = src.indexOf("signIn.oneDrivePkce()");
    const deviceCode = src.indexOf("$(key) OneDrive — код устройства");
    expect(browser).toBeGreaterThan(-1);
    expect(deviceCode).toBeGreaterThan(-1);
    expect(browser).toBeLessThan(deviceCode);
  });

  it("код устройства никуда не делся — он для SSH и контейнеров", () => {
    const src = read("src/commands/registerProviderSignIn.ts");
    expect(src).toContain("signIn.oneDrive(true)");
    expect(src).toContain("signIn.googleDrive(true)");
    expect(src).toContain("signIn.oneDrive(false)");
    expect(src).toContain("signIn.googleDrive(false)");
  });
});

describe("redirect URI совпадает с тем, что написано в гайде", () => {
  const guide = read("src/ui/providerSetupGuide.ts");

  it("OneDrive: порт из кода назван в инструкции по регистрации", () => {
    expect(ONEDRIVE_PKCE_REDIRECT_URI).toBe(
      `http://127.0.0.1:${String(ONEDRIVE_PKCE_REDIRECT_PORT)}/oauth-callback`,
    );
    // Гайд просит вписать этот URI в Azure — расхождение здесь означало бы
    // redirect_uri_mismatch у каждого, кто следовал инструкции.
    expect(guide).toContain(ONEDRIVE_PKCE_REDIRECT_URI);
  });

  it("Google Drive: URI построен на loopback (Desktop app принимает любой порт)", () => {
    expect(GDRIVE_PKCE_REDIRECT_URI).toBe(
      `http://127.0.0.1:${String(GDRIVE_PKCE_REDIRECT_PORT)}/oauth-callback`,
    );
    expect(guide).toContain("Desktop app");
  });
});
