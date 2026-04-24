import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";

execSync("bun build --target node --format esm --outfile pkg/dist/cli/index.mjs --external bun:sqlite cli/src/index.ts", { cwd: "..", stdio: 'inherit' });
execSync("tsc --project pkg/tsconfig-cli.json || true", { cwd: "..", stdio: 'inherit' });

// Create bin/host.js
await mkdir("dist/cli/bin", { recursive: true });
await writeFile("dist/cli/bin/host.js", `#!/usr/bin/env bun

import { runBunHost } from '../index.mjs';

const port = process.argv[2] ? Number.parseInt(process.argv[2]) : undefined;
runBunHost(port);
`, { mode: 0o755 });