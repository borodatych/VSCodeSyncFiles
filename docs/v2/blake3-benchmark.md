# BLAKE3 vs SHA-256 — benchmark

> Reference numbers for the `vscodesync.canonicalHashAlgo` setting.
> When deciding whether to switch a workspace from `sha256` to `blake3`,
> reproduce these locally — performance varies wildly with CPU, Node
> version, and whether the file is in the OS page cache.

## How to reproduce

```bash
npm i           # ensures @noble/hashes (optionalDependencies) is present
node scripts/benchmarks/blake3-bench.mjs
```

The script generates random buffers, warms both code paths, and prints a
markdown-friendly table. **Note:** synthetic random buffers approximate the
hashing cost only — the full pipeline (`normalize_line_endings →
sanitize_syncignore → SHA-256/BLAKE3 → [compress] → [encrypt] → upload`)
will be dominated by I/O for almost any real workspace.

## Sample numbers (Node 20.17, Windows 11, x64, single-threaded)

These are illustrative; expect ~1.5–4× speedup for BLAKE3 on
medium-to-large buffers. On tiny files SHA-256 sometimes wins because
node:crypto's startup overhead is amortised better.

| Workspace      | SHA-256 (node:crypto) | BLAKE3 (@noble/hashes) | Speedup |
|----------------|-----------------------|------------------------|---------|
| 10 × 5 KB      | ~0.3 ms               | ~0.8 ms                | 0.4×    |
| 100 × 50 KB    | ~10 ms                | ~12 ms                 | 0.8×    |
| 100 × 500 KB   | ~100 ms               | ~70 ms                 | 1.4×    |
| 10 × 5 MB      | ~600 ms               | ~250 ms                | 2.4×    |

> The `@noble/hashes` BLAKE3 backend is pure JS (~30 KB minified). For
> production-tier speed (10–15× over SHA-256) you want a WASM or native
> binding — out of scope for v2.3 (`@bokuweb/zstd-wasm` is the only WASM
> dep we ship today).

## When to switch

- **Stay on `sha256`** if your workspace is dominated by ≤ 50 KB files.
  The hashing cost is well below network latency, and the migration cost
  isn't worth the wash.
- **Switch to `blake3`** if you have ≥ 100 files in the 100 KB+ range
  (typical: media, lockfiles, build artifacts that you choose to track).
  The dual-hash transition window (`vscodesync.canonicalHashAlgo: "dual"`)
  lets every machine read both during the cutover.

## Dual-hash window

Recommended workflow (see `runHashAlgoMigrationCheck` in
`src/core/hashMigrationCheck.ts`):

1. Set `vscodesync.canonicalHashAlgo` to `"dual"` on every machine.
2. Wait for at least one full sync cycle on each machine (≤ 24 h on
   active workspaces).
3. Run `vscodesync.completeBlake3Migration` (skeleton — see roadmap;
   pure planner in `src/core/hashMigrationCheck.ts` reports
   `safeToSwitchToBlake3`).
4. When the report says "safe to switch", flip the setting to
   `"blake3"` everywhere.

Old `_meta.json` entries without `hashBlake3` will lazily upgrade on
the next push of each affected file — old readers ignore the
`hashBlake3` field, so there is no flag day.
