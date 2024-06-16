# DIPLOMATIC

Simple. Secure. Single-player sync.

`deno vendor src/*.ts tests/* --force` to vendor new deps.

## Client

`deno run --allow-net --allow-read --allow-write src/dbag.ts .state`

## Server

`deno run --allow-net src/server.ts`
