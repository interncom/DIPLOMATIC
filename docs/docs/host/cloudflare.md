# Cloudflare

Code lives in `hosts/cloudflare`. Protocol handling is shared (`shared/http`, `shared/api`); this package is the Worker + D1 + Durable Object wiring.

## Storage

Bags live in D1. The important batch methods:

### `setBags` (PUSH)

1. Builds one `INSERT … SELECT COALESCE(MAX(seq),0)+1 … RETURNING seq` per bag (seq allocated in SQL).
2. Runs statements with `D1.batch` (one SQL transaction per chunk of ≤500 statements).
3. Returns the assigned seq list to the PUSH handler for the response and NOTF fan-out.

### `getBodies` (PULL)

1. `SELECT seq, bodyCph FROM bags WHERE userPubKey = ? AND seq IN (…)` in chunks of ≤99 seq binds (~100 bound variables per statement on D1/SQLite; one slot is `userPubKey`). Same chunking on Deno/Bun hosts.
2. Returns only rows that exist.

See [host storage](../api/host#host-storage-interface), [PUSH](../api/push#host-processing), [PULL](../api/pull#host-processing).

## Realtime

- [x] Durable Objects notify clients over websocket (`WebSocketServerV2`).
- [ ] Store large bodies in R2, indexed by D1 (optional scale-out).
