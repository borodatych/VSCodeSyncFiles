import * as fs from "node:fs/promises";

const CHUNK = 8000;

/** Грубая эвристика: нулевой байт в начале файла → считаем двоичным. */
export async function fileLooksBinary(abs: string): Promise<boolean> {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    const { bytesRead } = await fh.read(buf, 0, CHUNK, 0);
    if (bytesRead === 0) {
      return false;
    }
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}
