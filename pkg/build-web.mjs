import { execSync } from "node:child_process";

execSync("bun build --target browser --format esm --outfile pkg/dist/web/index.mjs --external react web/src/index.ts", { cwd: "..", stdio: 'inherit' });
execSync("cd web && tsc --emitDeclarationOnly --outDir ../pkg/dist/web", { cwd: "..", stdio: 'inherit' });