This repo has a few related projects in it, implementing the DIPLOMATIC protocol for securely syncing application data via untrusted cloud hosts.

## Style

Prefer terse variable names, even at the expense of immediate readability to an outsider. Someone who spends time with the code will learn to recognize them. This project is meant to be very compact. It won't have many collaborators. GLOSSARY.md defines some terms. Do not use the ! operator or `as any` in TypeScript to cheat and avoid the type system. Generally follow the style of code in the files you're working on.

Run `style.sh` in the root of the project to enforce style rules after completing your work.

Write the minimum amount of code you can to achieve the task without sacrificing clarity. Don't do "code golf" tricks to shorten the code, but look for refactors or even rearchitectures that would reduce LOC.

Do not introduce new jargon without good reason.

## Change-Minimization

When implementing a change, there is sometimes a refactor that looks useful to do. Resist the urge to do it all together. We value keeping changes focused so that the commits are easy to read and understand. You can do the refactor in a follow-up commit.

## Terseness

To be useful this software must be trusted. To be trusted it must be understood. Therefore it is critical to keep the code compact. Long, explanatory variable and function names are *not* desirable here. The more-often repeated a variable or function name is, the shorter it should be. Introduce these common, short names with a one-line comment explaining the meaning. Rarely used variables, such as constants, can be relatively long and self-explanatory.

## Constraints

- Do not use typecasting `x as Type` in TypeScript.
- Do not use the `any` type in TypeScript.
- Do not use the TypeScript `!` operator.

## Directory Structure

- `shared` holds common code. It's written in TypeScript, targeting deno.
- `shared/api` implements the fundamental API calls of the protocol (client- and server-side).
- `shared/codecs` hold binary encoders and decoders (codecs) for data structures.
- `shared/crypto` holds all sensitive cryptographic operations code. Including the Enclave, which is the only piece of code allowed to touch unencrypted master keys.
- `shared/http` holds code implementing the HTTP transport for the protocol.
- `shared/lpc` holds code implementing the LPC (local procedure call) transport.
- `shared/types.ts` defines TypeScript types used.
- `deno` has some deno platform-specific code, plus the tests for the shared deno code. Run those tests with `deno test --allow-net --allow-ffi --allow-env` from the `deno` dir. Use `deno bench` to run the benchmarks.
- `web` holds web client code, also written in TypeScript. Run tests from this dir using `npm test`.
- `web/src/entdb` implements EntDB, an application-layer object database built on top of the eventually-consistent ordered message relay implemented by DIPLOMATIC. It has both IndexedDB and in-memory implementations.
- `web/src/stores` implement data stores on both IndexedDB and in-memory, for data needed to use DIPLOMATIC + EntDB in a web client.
- `web/src/types.ts` has various TypeScript types specific to the web client.
- `cli` holds CLI client code and build configuration.
- `cli/src` contains the CLI client implementation for connecting to DIPLOMATIC hosts.
- `bun` holds Bun-specific utilities and crypto implementations, including the Bun host server.
- `pkg` manages the build and packaging of the `@interncom/diplomatic` NPM module, which exposes web and CLI components from the monorepo. It pulls source from `shared/`, `web/`, `cli/`, and `bun/`. Run `bun install` then `bun run build` from this dir to generate distribution bundles.
- `demos` contains example usage of the DIPLOMATIC protocol, depending on the `pkg` module for imports.

## Checking Work

- Run tests before and after making changes to ensure you haven't broken anything.
  - `deno test --allow-net --allow-ffi --allow-env` from `deno` dir.
  - `npm test` from `web` dir.

- Check that TypeScript type-checks successfully with `npm run tsc` from `web` dir. Type errors and warnings are never acceptable.

- Run `bun install` then `bun run build` from `pkg` dir to ensure the NPM module builds successfully.

- Run the benchmarks before and after as well, to check for meaningful regressions.
  - `deno bench` from `deno` dir.

- Ensure that changes have not introduced new sensitive cryptographic operations outside the `shared/crypto` folder.
- Ensure that changes have not resulted in the unencrypted master seed (key) being accessible outside of the Enclave in `shared/crypto`.
