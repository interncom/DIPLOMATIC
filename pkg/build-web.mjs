import { execSync } from "node:child_process";

execSync(
  "bun build --target browser --format esm --outfile pkg/dist/web/index.mjs --external react --minify web/src/index.ts",
  { cwd: "..", stdio: "inherit" },
);
// Dedicated sync worker (protocol store + crypto + WS). Sibling of index.mjs.
execSync(
  "bun build --target browser --format esm --outfile pkg/dist/web/worker.mjs --minify web/src/worker/entry.ts",
  { cwd: "..", stdio: "inherit" },
);
execSync("cd web && tsc --emitDeclarationOnly --outDir ../pkg/dist/web", {
  cwd: "..",
  stdio: "inherit",
});