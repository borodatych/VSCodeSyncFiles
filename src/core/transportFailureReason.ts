/**
 * What a bare `fetch failed` actually meant.
 *
 * Node's `fetch` (undici) rejects with a `TypeError: fetch failed` whose only
 * useful content sits in `cause` — and sometimes one level deeper still. The
 * extension used to surface the outer message verbatim, so a whole workday of
 * blocked connections looked like "Yandex Disk: fetch failed" in the toast and
 * in the log: the one string that names neither the problem nor a remedy.
 *
 * This module walks the `cause` chain and turns the machine codes into a phrase
 * the user can act on. It is deliberately pure — no `vscode`, no provider
 * imports — so the same wording serves the toast, the diagnostics channel and
 * the tests.
 */

/** Longest `cause` chain worth walking; guards against self-referencing errors. */
const MAX_CAUSE_DEPTH = 5;

export interface TransportFailureReason {
  /** Machine code found in the chain (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, …), when any. */
  code?: string;
  /** Human phrase for the toast and the log. */
  text: string;
  /**
   * True when nothing in the chain named a cause. The caller keeps the raw
   * message in that case instead of inventing an explanation.
   */
  unknown: boolean;
}

function codeOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const raw = (e as { code?: unknown }).code;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "";
}

/** Collect the error and everything reachable through `cause`, outermost first. */
function causeChain(e: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = e;
  while (current !== undefined && current !== null && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/**
 * Wording per code.
 *
 * Only codes whose remedy differs are spelled out: a name that does not resolve
 * is a different problem from a connection that is dropped on the floor, and
 * telling them apart is the whole reason this table exists.
 */
function textForCode(code: string): string | undefined {
  switch (code) {
    case "UND_ERR_CONNECT_TIMEOUT":
      return "соединение не установилось за 10 с — адрес недоступен (фильтрация сети, VPN или прокси)";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "имя хоста не разрешается — нет DNS или нет сети";
    case "ECONNREFUSED":
      return "соединение отклонено — порт закрыт или запрос завернул прокси";
    case "ECONNRESET":
      return "соединение сброшено на полпути";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "сеть недоступна — нет маршрута до адреса";
    case "ETIMEDOUT":
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
      return "сервер не ответил вовремя";
    case "EPIPE":
    case "UND_ERR_SOCKET":
      return "соединение оборвалось";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return "сертификат не прошёл проверку — вероятно, трафик перехватывает корпоративный прокси";
    default:
      return undefined;
  }
}

/**
 * Explain a transport-level failure.
 *
 * The outer `TypeError: fetch failed` is skipped as a message source on
 * purpose: it is noise in every single case. Its `cause` is what carries the
 * answer.
 */
export function describeTransportFailure(e: unknown): TransportFailureReason {
  const chain = causeChain(e);
  for (const link of chain) {
    const code = codeOf(link);
    if (code === undefined) continue;
    const text = textForCode(code);
    return text === undefined
      ? { code, text: `${messageOf(link) || code} (${code})`, unknown: false }
      : { code, text: `${text} (${code})`, unknown: false };
  }
  // No code anywhere: fall back to the innermost message that says anything at
  // all, and only then to the outer one.
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const msg = messageOf(chain[i]);
    if (msg.length > 0 && msg !== "fetch failed") {
      return { text: msg, unknown: false };
    }
  }
  return { text: messageOf(e) || "неизвестная ошибка сети", unknown: true };
}

/** `<provider>: <reason>` — the message a `NETWORK_ERROR` carries. */
export function describeProviderTransportFailure(provider: string, e: unknown): string {
  return `${provider}: ${describeTransportFailure(e).text}`;
}
