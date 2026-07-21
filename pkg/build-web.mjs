import { execSync } from "node:child_process";
import { printSizeBreakdown } from "./size-breakdown.mjs";

const verbose = process.argv.includes("--verbose");

// bun build cwd is repo root; printSizeBreakdown runs from pkg/
const webMetaFromRoot = "pkg/dist/web/index.meta.json";
const workerMetaFromRoot = "pkg/dist/web/worker.meta.json";
const webMetaFlag = verbose ? ` --metafile=${webMetaFromRoot}` : "";
const workerMetaFlag = verbose ? ` --metafile=${workerMetaFromRoot}` : "";

execSync(
  `bun build --target browser --format esm --outfile pkg/dist/web/index.mjs --external react --minify${webMetaFlag} web/src/index.ts`,
  { cwd: "..", stdio: "inherit" },
);
if (verbose) await printSizeBreakdown("dist/web/index.meta.json", "web/index.mjs");

// Dedicated sync worker (protocol store + crypto + WS). Sibling of index.mjs.
execSync(
  `bun build --target browser --format esm --outfile pkg/dist/web/worker.mjs --minify${workerMetaFlag} web/src/worker/entry.ts`,
  { cwd: "..", stdio: "inherit" },
);
if (verbose) await printSizeBreakdown("dist/web/worker.meta.json", "web/worker.mjs");

execSync("cd web && tsc --emitDeclarationOnly --outDir ../pkg/dist/web", {
  cwd: "..",
  stdio: "inherit",
});
