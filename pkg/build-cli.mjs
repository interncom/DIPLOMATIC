import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { printSizeBreakdown } from "./size-breakdown.mjs";

const verbose = process.argv.includes("--verbose");

// bun build cwd is repo root; printSizeBreakdown runs from pkg/
const cliMetaFromRoot = "pkg/dist/cli/index.meta.json";
const cliMetaFlag = verbose ? ` --metafile=${cliMetaFromRoot}` : "";

execSync(
  `bun build --target node --format esm --outfile pkg/dist/cli/index.mjs --external bun:sqlite --minify${cliMetaFlag} cli/src/index.ts`,
  { cwd: "..", stdio: "inherit" },
);
if (verbose) await printSizeBreakdown("dist/cli/index.meta.json", "cli/index.mjs");

execSync("tsc --project pkg/tsconfig-cli.json", { cwd: "..", stdio: "inherit" });

// Create bin/host.js
await mkdir("dist/cli/bin", { recursive: true });
await writeFile("dist/cli/bin/host.js", `#!/usr/bin/env bun

import { runBunHost } from '../index.mjs';

const port = process.argv[2] ? Number.parseInt(process.argv[2]) : undefined;
runBunHost(port);
`, { mode: 0o755 });
