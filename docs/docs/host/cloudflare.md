# Cloudflare

Code lives in `hosts/cloudflare`. Protocol handling is shared (`shared/http`, `shared/api`); this package is the Worker + D1 + Durable Object wiring.

## Storage (`setBags`)

Bags are stored in D1. PUSH calls `IStorage.setBags`, which:

1. Builds one `INSERT … SELECT COALESCE(MAX(seq),0)+1 … RETURNING seq` per bag (seq allocated in SQL, not a separate MAX then write).
2. Runs statements with `D1.batch` (one SQL transaction per chunk of ≤500 statements).
3. Returns the assigned seq list to the PUSH handler for the response and NOTF fan-out.

See [host storage](../api/host#host-storage-interface) and [PUSH](../api/push#host-processing).

## Realtime

- [x] Durable Objects notify clients over websocket (`WebSocketServerV2`).
- [ ] Store large bodies in R2, indexed by D1 (optional scale-out).
