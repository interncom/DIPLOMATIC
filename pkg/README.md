# @interncom/diplomatic Package

This directory manages the build and packaging of the `@interncom/diplomatic` NPM module, which provides secure sync layer and CLI utilities for the DIPLOMATIC protocol.

## Overview

The `@interncom/diplomatic` package exposes both web (browser) and CLI (Node.js) components from the monorepo:

- **Web components**: React hooks, client APIs, and storage utilities for browser-based applications
- **CLI components**: Command-line tools and host server for Node.js environments

## Building the NPM Module

First, install dependencies:

```bash
bun install
```

To clean previous builds:

```bash
bun run clean
```

Then run the build script to generate the distribution bundles:

```bash
bun run build
```

This command:
1. Builds the web bundle (`dist/web/index.mjs`) from `../web/src/index.ts`
2. Builds the CLI bundle (`dist/cli/index.mjs`) from `../cli/src/index.ts` (with external dependencies like `libsodium-wrappers`)
3. Generates the CLI binary (`dist/cli/bin/host.js`) for the `diplomatic-host` command
4. Builds the Bun client (`dist/bun/index.mjs`) from `../bun/src/client/pkg.ts`. That entry is not the host.

Note: The CLI bundle uses external dependencies that must be installed and available at runtime.

## Package Exports

The package uses conditional exports for environment-specific loading:

```json
{
  ".": {
    "browser": "./dist/web/index.mjs",
    "node": "./dist/cli/index.mjs"
  },
  "./web": "./dist/web/index.mjs",
  "./cli": "./dist/cli/index.mjs",
  "./bun": {
    "bun": "./dist/bun/index.mjs"
  }
}
```

- **Browser environments**: Automatically loads web components
- **Node.js environments**: Automatically loads CLI components, including the host binary
- **Explicit imports**: Use `./web` or `./cli` for those components
- **Bun client**: `import { openDisk, installPair, openRing } from "@interncom/diplomatic/bun"`. That entry is the disk store and YubiKey ring. It is not the host. `SyncClient` and the pairing helpers come from `./web`. A tsc project needs `"customConditions": ["bun"]`. `tools/data/data.ts` imports both entries.

## Dependencies

This package pulls source code from:
- `../shared/`: Common TypeScript utilities
- `../web/`: Web client source
- `../cli/`: Node CLI and host entry
- `../bun/`: Host loaded by `diplomatic-host`. `pkg/bun/build-bun.mjs` builds the client entry.

## Publishing

To publish the package:

```bash
npm publish
```

NOTE: that must be `npm publish` not `bun publish`.

The package is configured for public access with scoped name `@interncom/diplomatic`.
