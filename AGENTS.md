This repo has a few related projects in it, implementing the DIPLOMATIC protocol for securely syncing application data via untrusted cloud hosts.

## Style

Prefer terse variable names, even at the expense of immediate readability to an outsider. Someone who spends time with the code will learn to recognize them. This project is meant to be very compact. It won't have many collaborators. GLOSSARY.md defines some terms. Do not use the ! operator or `as any` in TypeScript to cheat and avoid the type system. Generally follow the style of code in the files you're working on.

## Constraints

- Do not use typecasting `x as Type` in TypeScript.
- Do not use the TypeScript `!` operator.

## Directory Structure

- `shared` holds common code. It's written in TypeScript, targeting deno.
- `deno` has some deno platform-specific code, plus the tests for the shared deno code. Run those tests with `deno test --allow-net` from the `deno` dir. Use `deno bench` to run the benchmarks.
- `web` holds web client code, also written in TypeScript. Run tests from this dir using `npm test`.

## Checking Work

- Run tests before and after making changes to ensure you haven't broken anything.
  - `deno test --allow-net` from `deno` dir.
  - `npm test` from `web` dir.
  
- Run the benchmarks before and after as well, to check for meaningful regressions.
  - `deno bench` from `deno` dir.
  
- Format the code.
  - `deno fmt` in the `deno` dir.
  - `deno fmt` in the `web` dir.
