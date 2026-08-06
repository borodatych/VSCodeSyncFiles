import { describe, expect, it } from "vitest";
import { planUploadEncoding } from "../../src/core/plan/planUploadEncoding.js";
import { decodeCloudBlob } from "../../src/core/cloudBlobCodec.js";

const TEXT = Buffer.from("x".repeat(4096), "utf8");

describe("planUploadEncoding", () => {
  it("без сжатия и шифрования: байты и путь без .gz", () => {
    const p = planUploadEncoding({
      workspaceId: "ws",
      posixRel: "src/a.ts",
      plaintext: Buffer.from("hi"),
    });
    expect(p.wireGzip).toBe(false);
    expect(p.body.toString("utf8")).toBe("hi");
    expect(p.cloudPath.endsWith(".gz")).toBe(false);
    expect(p.cloudPath).toContain("src/a.ts");
  });

  it("сжатие сработало → путь получает .gz (иначе блоб указывает в никуда)", () => {
    const p = planUploadEncoding({
      workspaceId: "ws",
      posixRel: "src/a.ts",
      plaintext: TEXT,
      compressUploads: true,
    });
    expect(p.wireGzip).toBe(true);
    expect(p.cloudPath.endsWith(".gz")).toBe(true);
    expect(p.body.length).toBeLessThan(TEXT.length);
  });

  it("несжимаемое содержимое остаётся без .gz даже при compressUploads", () => {
    const random = Buffer.from(
      Array.from({ length: 64 }, (_, i) => (i * 7919) % 256),
    );
    const p = planUploadEncoding({
      workspaceId: "ws",
      posixRel: "a.bin",
      plaintext: random,
      compressUploads: true,
    });
    expect(p.wireGzip).toBe(false);
    expect(p.cloudPath.endsWith(".gz")).toBe(false);
  });

  it("шифрование + сжатие обратимы через decodeCloudBlob", () => {
    const encrypt = (b: Buffer): Buffer => Buffer.concat([Buffer.from([0xaa]), b]);
    const decrypt = (b: Buffer): Buffer => b.subarray(1);
    const p = planUploadEncoding({
      workspaceId: "ws",
      posixRel: "src/a.ts",
      plaintext: TEXT,
      compressUploads: true,
      encrypt,
      decrypt,
    });
    expect(p.body[0]).toBe(0xaa);
    expect(decodeCloudBlob(p.body, p.wireGzip, { decrypt })).toEqual(TEXT);
  });
});
