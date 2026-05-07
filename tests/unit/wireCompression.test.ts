import { describe, expect, it } from "vitest";
import { gzipIfShrinks, gunzipToPlaintext } from "../../src/core/wireCompression.js";

describe("wireCompression", () => {
  it("gzipIfShrinks returns smaller buffer for repetitive text", () => {
    const plain = Buffer.from("hello\n".repeat(2000), "utf8");
    const gz = gzipIfShrinks(plain);
    expect(gz).toBeDefined();
    expect(gz!.length).toBeLessThan(plain.length);
    expect(gunzipToPlaintext(gz!).equals(plain)).toBe(true);
  });

  it("gzipIfShrinks returns undefined when gzip does not shrink enough", () => {
    const plain = Buffer.from("hi", "utf8");
    expect(gzipIfShrinks(plain)).toBeUndefined();
  });
});
