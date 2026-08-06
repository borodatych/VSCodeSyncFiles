import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const cliPkg = JSON.parse(readFileSync(new URL("./cli/package.json", import.meta.url), "utf8"));

const watch = process.argv.includes("--watch");

const base = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: "info",
};

const builds = [
  esbuild.context({
    ...base,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  }),
  esbuild.context({
    ...base,
    entryPoints: ["src/extension.web.ts"],
    outfile: "dist/extension.web.js",
    platform: "browser",
    format: "cjs",
    external: ["vscode"],
  }),
  esbuild.context({
    ...base,
    entryPoints: ["tests/integration/suite/index.ts"],
    outfile: "dist/test/suite/index.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  }),
  esbuild.context({
    ...base,
    banner: {
      js: "#!/usr/bin/env node",
    },
    entryPoints: ["cli/src/main.ts"],
    outfile: "cli/dist/cli.cjs",
    platform: "node",
    format: "cjs",
    // keytar is an optional native module — keep external so the bundle doesn't
    // try to inline the .node binary; falls back gracefully when absent.
    external: ["keytar"],
    define: {
      __CLI_VERSION__: JSON.stringify(cliPkg.version ?? "0.0.1"),
    },
  }),
  // The DuckDB-WASM analytics bridge is NOT built for 1.0.0. The panel it
  // served could not work in a packaged extension anyway: its `.wasm` and
  // worker URIs point into `node_modules/@duckdb/duckdb-wasm/dist`, which
  // `.vscodeignore` excludes from the `.vsix`. Shipping it would mean shipping
  // a 426 KB bridge for a command that always fails. Intent and the cost of
  // finishing it are recorded in `docs/v2/deferredWiring.md`.
];

async function main() {
  const contexts = await Promise.all(builds);
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
