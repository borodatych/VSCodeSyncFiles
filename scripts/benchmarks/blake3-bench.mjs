/**
 * v2.3.5 — Node-side benchmark for SHA-256 vs BLAKE3 over a synthetic
 * workspace. Not executed in CI — run manually:
 *
 *   node scripts/benchmarks/blake3-bench.mjs
 *
 * Output is a markdown-friendly table the operator can paste into
 * docs/v2/blake3-benchmark.md to record their numbers.
 */
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

let blake3;
try {
  blake3 = (await import("@noble/hashes/blake3")).blake3;
} catch {
  console.error("@noble/hashes is not installed in this build — install via npm i @noble/hashes");
  process.exit(1);
}

const WORKSPACES = [
  { label: "10 × 5 KB", count: 10, size: 5 * 1024 },
  { label: "100 × 50 KB", count: 100, size: 50 * 1024 },
  { label: "100 × 500 KB", count: 100, size: 500 * 1024 },
  { label: "10 × 5 MB", count: 10, size: 5 * 1024 * 1024 },
];

function buildBuffers(count, size) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(randomBytes(size));
  return out;
}

function timeSha256(buffers) {
  const start = performance.now();
  let acc = 0;
  for (const b of buffers) {
    acc += createHash("sha256").update(b).digest()[0];
  }
  const elapsed = performance.now() - start;
  return { elapsedMs: elapsed, sentinel: acc };
}

function timeBlake3(buffers) {
  const start = performance.now();
  let acc = 0;
  for (const b of buffers) {
    acc += blake3(b, { dkLen: 32 })[0];
  }
  const elapsed = performance.now() - start;
  return { elapsedMs: elapsed, sentinel: acc };
}

console.log("# BLAKE3 vs SHA-256 benchmark");
console.log("");
console.log(`Node ${process.version}, ${process.platform} ${process.arch}`);
console.log("");
console.log("| Workspace | SHA-256 | BLAKE3 | Speedup |");
console.log("|-----------|---------|--------|---------|");

for (const w of WORKSPACES) {
  const buffers = buildBuffers(w.count, w.size);
  // Warm-up.
  timeSha256(buffers.slice(0, Math.min(3, buffers.length)));
  timeBlake3(buffers.slice(0, Math.min(3, buffers.length)));

  const sha = timeSha256(buffers);
  const b3 = timeBlake3(buffers);
  const speedup = sha.elapsedMs / b3.elapsedMs;
  console.log(
    `| ${w.label} | ${sha.elapsedMs.toFixed(1)} ms | ${b3.elapsedMs.toFixed(1)} ms | ${speedup.toFixed(2)}× |`,
  );
}
