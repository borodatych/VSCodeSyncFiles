/**
 * v0.16 N12 — pure builder for the mode-aware welcome / empty-state
 * formatter.
 *
 * When autoSyncMode = check-only / off, the standard "Get started"
 * welcome is misleading ("VSCodeSync will sync your files!"). This
 * helper produces a mode-specific welcome line + recommended action.
 */

import type { AutoSyncMode } from "./autoSyncMode.js";

export interface WelcomeMessage {
  /** Headline for the empty state. */
  headline: string;
  /** One-line body explanation. */
  body: string;
  /** Optional command to surface as the call-to-action. */
  ctaCommandId?: string;
  /** Label for the CTA button. */
  ctaLabel?: string;
}

export function buildWelcomeMessage(
  mode: AutoSyncMode,
  pendingCount: number,
  cloudNewerCount: number,
  conflictCount: number,
): WelcomeMessage {
  if (conflictCount > 0) {
    return {
      headline: `${String(conflictCount)} файл${plural(conflictCount, "", "а", "ов")} в конфликте`,
      body: "Откройте окно конфликтов, чтобы выбрать Keep Mine / Take Theirs / Keep Both.",
      ctaCommandId: "vscodesync.resolveConflicts",
      ctaLabel: "Открыть конфликты",
    };
  }
  if (mode === "off") {
    if (pendingCount > 0 || cloudNewerCount > 0) {
      return {
        headline: "Авто-синхронизация выключена",
        body: `${String(pendingCount + cloudNewerCount)} файл${plural(pendingCount + cloudNewerCount, "", "а", "ов")} требуют действия. Push/Pull вручную.`,
        ctaCommandId: "vscodesync.bulkPush",
        ctaLabel: "Open Bulk Push",
      };
    }
    return {
      headline: "Авто-синхронизация выключена",
      body: "Никаких автоматических действий. Используйте Push / Pull / Sync вручную или переключите режим.",
      ctaCommandId: "vscodesync.cycleAutoSyncMode",
      ctaLabel: "Сменить авто-режим",
    };
  }
  if (mode === "check-only") {
    if (pendingCount > 0) {
      return {
        headline: `${String(pendingCount)} файл${plural(pendingCount, "", "а", "ов")} готов${plural(pendingCount, "", "ы", "ы")} к Push`,
        body: "Авто-режим: только проверка. Нажмите Push All когда захотите отправить.",
        ctaCommandId: "vscodesync.pushAll",
        ctaLabel: "Push All",
      };
    }
    if (cloudNewerCount > 0) {
      return {
        headline: `${String(cloudNewerCount)} файл${plural(cloudNewerCount, "", "а", "ов")} новее в облаке`,
        body: "Авто-режим: только проверка. Нажмите Pull All чтобы скачать.",
        ctaCommandId: "vscodesync.pullAll",
        ctaLabel: "Pull All",
      };
    }
    return {
      headline: "Всё актуально",
      body: "Авто-режим: только проверка. Push/Pull выполняются вручную.",
    };
  }
  // full
  if (pendingCount > 0) {
    return {
      headline: `${String(pendingCount)} файл${plural(pendingCount, "", "а", "ов")} ждут push`,
      body: "Push выполнится автоматически на следующем триггере (save / focus).",
    };
  }
  if (cloudNewerCount > 0) {
    return {
      headline: `${String(cloudNewerCount)} файл${plural(cloudNewerCount, "", "а", "ов")} новее в облаке`,
      body: "Pull выполнится при следующем открытии файла или focus.",
    };
  }
  return {
    headline: "Всё актуально",
    body: "Все файлы синхронизированы.",
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
