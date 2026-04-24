import { execSync } from "node:child_process";

execSync("esbuild --bundle --format=esm --outfile=pkg/dist/web/index.mjs --platform=browser --target=esnext --external:react --external:@noble/hashes web/src/index.ts", { cwd: "..", stdio: 'inherit' });