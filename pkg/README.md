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
2. Builds the CLI bundle (`dist/cli/index.mjs`) from `../web/src/cli/index.ts` (with external dependencies like `libsodium-wrappers`)
3. Generates the CLI binary (`dist/cli/bin/host.js`) for the `diplomatic-host` command

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
  "./cli": "./dist/cli/index.mjs"
}
```

- **Browser environments**: Automatically loads web components
- **Node.js environments**: Automatically loads CLI components
- **Explicit imports**: Use `./web` or `./cli` subpaths for specific components

## Dependencies

This package pulls source code from:
- `../shared/`: Common TypeScript utilities
- `../web/`: Web client source
- `../bun/`: Additional utilities (via symlinks in `../web/src/`)

## Publishing

To publish the package:

```bash
npm publish
```

The package is configured for public access with scoped name `@interncom/diplomatic`.