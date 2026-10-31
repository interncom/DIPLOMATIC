# Cloudflare

Code lives in `hosts/cloudflare`. Protocol handling is shared (`shared/http`, `shared/api`); this package is the Worker + D1 + Durable Object wiring.

## Storage

Bags are indexed in D1. `headCph` always stays in the row. A `bodyCph` of 1 MiB or less (`maxInlineBodyBytes` in `shared/bodykey.ts`) stays in the row too. A larger body is written to R2 first, and the row stores that object's key in `bodyKey` with `bodyCph` null. The key is `userPubKey` hex, realm hex, and 16 random bytes. D1's row cap is 2,000,000 bytes; 1 MiB leaves room for the head and matches the client's soft push cap.

### `setBags` (PUSH)

1. Puts each oversized body in R2, and those puts run in parallel. A put that fails is `StorageError` for that bag: the row is not inserted, and any partial object is deleted. The other bags are still stored. If a D1 batch does not commit, objects for rows that did not commit are deleted and the call fails.
2. Builds one `INSERT … SELECT COALESCE(MAX(seq),0)+1 … RETURNING seq` per bag that will be stored (seq allocated in SQL).
3. Runs statements with `D1.batch` (one SQL transaction per chunk of ≤500 statements).
4. Returns one result per input bag. Success carries the assigned seq. PUSH writes that status on the bag's push item and omits `seq` when it is not success.

### `getBodies` (PULL)

1. `SELECT seq, bodyCph, bodyKey FROM bags WHERE userPubKey = ? AND rlm = ? AND seq IN (…)` in chunks of ≤98 seq binds (~100 bound variables per statement on D1/SQLite; two slots are `userPubKey` and `rlm`). Same chunking on Deno/Bun hosts.
2. Inline bodies come from the row. Each `bodyKey` is read from R2, and those reads run in parallel.
3. Missing seqs are omitted. A row whose R2 object is gone is a storage error.

See [host storage](../api/host#host-storage-interface), [PUSH](../api/push#host-processing), [PULL](../api/pull#host-processing).

## Realtime

- [x] Durable Objects notify clients over websocket (`WebSocketServerV2`).
- [x] Store large bodies in R2, indexed by D1.
