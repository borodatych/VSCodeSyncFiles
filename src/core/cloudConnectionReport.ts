/**
 * Verdict for "check the cloud connection" — the question a user actually has
 * when sync stops working ("is it me, my network, or the service?").
 *
 * Pure: the command measures, this module words the answer. Written after a
 * workday lost to `fetch failed` toasts that named neither cause nor remedy.
 */
import { describeTransportFailure } from "./transportFailureReason.js";

export type CloudConnectionVerdict =
  | { kind: "ok"; provider: string; elapsedMs: number }
  | { kind: "slow"; provider: string; elapsedMs: number }
  | { kind: "unauthorized"; provider: string }
  | { kind: "rate_limited"; provider: string; retryAfterMs?: number }
  | { kind: "unreachable"; provider: string; reason: string; code?: string }
  | { kind: "no_provider" };

/** Above this a round-trip is worth mentioning even though it succeeded. */
export const SLOW_ROUNDTRIP_MS = 3_000;

export interface CloudProbeOutcomeInput {
  provider: string;
  elapsedMs: number;
  /** Provider error code, when the probe threw a `ProviderError`. */
  errorCode?: string;
  error?: unknown;
  retryAfterMs?: number;
}

export function verdictForCloudProbe(input: CloudProbeOutcomeInput): CloudConnectionVerdict {
  const { provider, elapsedMs } = input;
  if (input.errorCode === "UNAUTHORIZED") {
    return { kind: "unauthorized", provider };
  }
  if (input.errorCode === "RATE_LIMITED") {
    return input.retryAfterMs === undefined
      ? { kind: "rate_limited", provider }
      : { kind: "rate_limited", provider, retryAfterMs: input.retryAfterMs };
  }
  if (input.error !== undefined) {
    const reason = describeTransportFailure(input.error);
    return reason.code === undefined
      ? { kind: "unreachable", provider, reason: reason.text }
      : { kind: "unreachable", provider, reason: reason.text, code: reason.code };
  }
  return elapsedMs >= SLOW_ROUNDTRIP_MS
    ? { kind: "slow", provider, elapsedMs }
    : { kind: "ok", provider, elapsedMs };
}

/** One line for the toast; the detail goes to the Diagnostics channel. */
export function describeCloudConnectionVerdict(v: CloudConnectionVerdict): string {
  switch (v.kind) {
    case "no_provider":
      return "VSCodeSync: провайдер не выбран или вход не выполнен — проверять нечего.";
    case "ok":
      return `VSCodeSync: ${v.provider} отвечает — ${String(v.elapsedMs)} мс. Связь в порядке.`;
    case "slow":
      return `VSCodeSync: ${v.provider} отвечает, но медленно — ${String(v.elapsedMs)} мс. Синхронизация будет вялой.`;
    case "unauthorized":
      return `VSCodeSync: ${v.provider} отклонил токен — нужен повторный вход.`;
    case "rate_limited":
      return v.retryAfterMs === undefined
        ? `VSCodeSync: ${v.provider} ограничивает частоту запросов — подождите и повторите.`
        : `VSCodeSync: ${v.provider} ограничивает частоту запросов — повторить можно через ${String(
            Math.ceil(v.retryAfterMs / 1000),
          )} с.`;
    case "unreachable":
      return `VSCodeSync: нет связи с ${v.provider} — ${v.reason}.`;
  }
}

/**
 * What to try next. Returned separately from the verdict text so the caller can
 * put it in the log even when the toast is dismissed.
 */
export function adviceForCloudConnectionVerdict(v: CloudConnectionVerdict): string | undefined {
  switch (v.kind) {
    case "unreachable":
      return v.code === "UND_ERR_CONNECT_TIMEOUT" || v.code === "EHOSTUNREACH" || v.code === "ENETUNREACH"
        ? "Соединение не устанавливается вовсе — так выглядит блокировка на сетевом периметре. Проверьте корпоративный фильтр, VPN или прокси; на другой сети то же самое обычно работает."
        : v.code === "ENOTFOUND" || v.code === "EAI_AGAIN"
          ? "Имя хоста не разрешается: проверьте, есть ли сеть вообще и отвечает ли DNS."
          : "Сеть недоступна или обрывается. Файлы не тронуты — повторите, когда связь вернётся.";
    case "unauthorized":
      return "Выполните вход заново: палитра → «VibeSync: Выбрать провайдера».";
    case "rate_limited":
      return "Провайдер просит снизить частоту. Помогает профиль фоновых опросов «щадящий» или «минимальный».";
    case "slow":
      return "Большие файлы будут идти долго. Если это надолго, имеет смысл профиль фоновых опросов «щадящий».";
    case "no_provider":
      return "Сначала выберите облако и войдите в него.";
    case "ok":
      return undefined;
  }
}
