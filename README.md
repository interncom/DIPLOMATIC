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

### Server

`DIPLOMATIC_HOST_PORT=31337 DIPLOMATIC_HOST_ID=abc123 deno run --allow-net --allow-read --allow-write --allow-env hosts/deno/server.ts`

### CLI

`echo "hello dip2" | DIPLOMATIC_HOST_URL=http://localhost:31337 DIPLOMATIC_SEED_HEX=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF deno run --allow-net --allow-env tools/dipcat/dipcat.ts`

`DIPLOMATIC_HOST_URL=http://localhost:31337 DIPLOMATIC_SEED_HEX=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF deno run --allow-net --allow-env tools/diplog/diplog.ts`
