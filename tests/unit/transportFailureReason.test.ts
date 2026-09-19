/**
 * «fetch failed» — единственное, что undici кладёт во внешнее сообщение.
 * Разбор цепочки `cause` — то, что отличает закрытый порт от мёртвого DNS.
 */
import { describe, expect, it } from "vitest";
import {
  describeProviderTransportFailure,
  describeTransportFailure,
} from "../../src/core/transportFailureReason.js";

function undiciStyle(code: string, innerMessage = "connect error"): Error {
  const inner = Object.assign(new Error(innerMessage), { code });
  return new TypeError("fetch failed", { cause: inner });
}

describe("describeTransportFailure", () => {
  it("называет connect timeout человеческими словами", () => {
    const r = describeTransportFailure(undiciStyle("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"));
    expect(r.code).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(r.text).toContain("соединение не установилось");
    expect(r.unknown).toBe(false);
  });

  it("отличает мёртвый DNS от отказа в соединении", () => {
    expect(describeTransportFailure(undiciStyle("ENOTFOUND")).text).toContain("имя хоста");
    expect(describeTransportFailure(undiciStyle("ECONNREFUSED")).text).toContain("отклонено");
  });

  it("узнаёт перехват TLS корпоративным прокси", () => {
    const r = describeTransportFailure(undiciStyle("SELF_SIGNED_CERT_IN_CHAIN"));
    expect(r.text).toContain("прокси");
  });

  it("незнакомый код отдаёт как есть, не выдумывая объяснения", () => {
    const r = describeTransportFailure(undiciStyle("EWEIRD", "что-то странное"));
    expect(r.code).toBe("EWEIRD");
    expect(r.text).toContain("EWEIRD");
    expect(r.unknown).toBe(false);
  });

  it("без кода берёт самое внутреннее осмысленное сообщение", () => {
    const err = new TypeError("fetch failed", { cause: new Error("socket hang up") });
    expect(describeTransportFailure(err).text).toBe("socket hang up");
  });

  it("совсем пустой случай помечает как неизвестный, а не врёт", () => {
    const r = describeTransportFailure(new TypeError("fetch failed"));
    expect(r.unknown).toBe(true);
    expect(r.text).toBe("fetch failed");
  });

  it("зацикленную цепочку causes не крутит бесконечно", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    expect(() => describeTransportFailure(a)).not.toThrow();
  });

  it("не разваливается на строке и на undefined", () => {
    expect(describeTransportFailure("boom").text).toBe("boom");
    expect(describeTransportFailure(undefined).unknown).toBe(true);
  });
});

describe("describeProviderTransportFailure", () => {
  it("подписывает провайдера перед причиной", () => {
    const msg = describeProviderTransportFailure("Yandex Disk", undiciStyle("ENOTFOUND"));
    expect(msg.startsWith("Yandex Disk: ")).toBe(true);
    expect(msg).not.toBe("Yandex Disk: fetch failed");
  });
});
