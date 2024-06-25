# DIPLOMATIC

Simple. Secure. Single-player sync.

DIPLOMATIC is a secure sync protocol for single-user distributed applications.

## Features
- Eventual Consistency — When all of a user's clients can reach their sync host, the host has not lost any data, and clients and host follow the protocol, every client is guaranteed to eventually achieve the same state.
- Blind Hosts — Hosts cannot inspect the contents of synced data packets. Data is end-to-end encrypted.
- Cryptographic Identity — Hosts identify clients using asymmetric cryptography. Full privacy depends on whether hosts require payment mechanisms involving additional identity, but the protocol does not require it.
- Application Agnostic — DSP uses a general pattern called [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) that can model any database (DBMS's call the concept a [Write-Ahead Log](https://www.postgresql.org/docs/current/wal-intro.html)).

## Development

From `deno` dir, `deno vendor src/*.ts tests/* --force` to vendor new deps.

### Client

1. `cd web`
1. `npm run dev`

See also `web/README.md`.

### Server

`DIPLOMATIC_HOST_ID=id123 DIPLOMATIC_HOST_PORT=3311 DIPLOMATIC_REG_TOKEN=tok123 deno run --allow-env --allow-net --allow-read hosts/deno/server.ts --https`
