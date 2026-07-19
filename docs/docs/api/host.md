# Host API

The DIPLOMATIC protocol has 4 endpoints, plus the [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) channel.

## Endpoints

- [`USER`](./user) Registers a user.
- [`PEEK`](./peek) Fetches bag headers uploaded since provided sequence number SEQ.
- [`PUSH`](./push) Uploads bags.
- [`PULL`](./pull) Fetches a list of bags with provided sequence numbers.
- [`NOTF`](./notf) `https://hostURL?t=<authTSHex>` Initiate a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) connection to receive new bags in real-time.
    
### Response Header

All API responses (excluding the websocket) begin with a standard response header. It looks like this:

```
export interface IRespHead {
  // Overall status of the request.
  status: Status; // 1 byte

  // NTP-style timestamps for client to compute offset from host clock.
  timeRcvd: Date; // ~6 bytes
  timeSent: Date; // ~6 bytes

  subscription: ISubscriptionMetadata; // ~30 bytes
}
```

Each response includes a status code so the client can know if the request succeeded or if not, why not. The timeRcvd and timeSent timestamps allow the client to determine if it is in-sync with the host's clock, using [NTP](https://www.rfc-editor.org/rfc/rfc958) logic, which can indicate if the client's clock is wrong. The subscription information allows the client to anticipate if it is at risk of losing service from this host, which could compromise data availability, particularly if the client is not maintaining a full message archive.

```
// ~30 bytes.
export interface ISubscriptionMetadata {
  // Duration of subscrption term in milliseconds.
  // 0 indicates an indefinite term (either lifetime or pay-as-you-go).
  term: number;

  // Milliseconds since start of term.
  elapsed: number;

  // "static" usage, i.e. storage.
  stat: IUsageQuota;

  // "dynamic" usage, i.e. time (bandwidth, CPU time, ...).
  dyn: IUsageQuota;
}

export interface IUsageQuota {
  quota: number;
  usage?: number;
}
```

Total size of the response header is about 43 bytes.

## Host storage interface

Wire endpoints are thin over a host-local storage abstraction (`IStorage`). Implementations (SQLite, D1, in-memory) provide:

| Method | Role |
|--------|------|
| `addUser` / `hasUser` | Registration |
| `subMeta` | Subscription / quota metadata for response headers |
| `setBags(pubKey, bags)` | Persist bags; return host `seq` for each bag **in order** |
| `getBody(pubKey, seq)` | Ciphertext body for [PULL](./pull) |
| `listHeads(pubKey, minSeq)` | Heads with `seq > minSeq` for [PEEK](./peek) |

### `setBags`

```ts
setBags(pubKey: PublicKey, bags: IBag[]): Promise<ValStat<number[]>>
```

- **Empty list** succeeds and returns `[]`.
- **Return value** is one host sequence number per input bag, same order as `bags`.
- **Atomic seq assignment:** a single call must allocate contiguous seqs without racing another concurrent `setBags` for the same user (e.g. one SQL transaction, or D1 `batch` with `MAX(seq)+1` inside each `INSERT … RETURNING seq`).
- A single bag is just `setBags(pubKey, [bag])` — there is no separate one-shot store API.

[PUSH](./push) verifies signatures, then stores all valid bags with one `setBags` call (not one write per bag).
