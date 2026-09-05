# EntDB (Entity Database)

##  Protocol Layers

### Msgs (Messages)

The atomic unit of the DIPLOMATIC protocol is the message, abbreviated msg. A message is an update (insert, update, or delete) to an application data object. Each message carries with it the complete state of the object, as well as metadata necessary to achieve consistent ordering of messages, to achieve an eventually consistent state of application data objects across all devices.

### Ents (Entities)

In DIPLOMATIC, we call these application data objects "ents", short for "entities". As applications receive new messages, they update their entities to reflect the latest state of each application data object encoded in the messages.

EntDB adds concepts on top of the raw DIPLOMATIC protocol:

1. "type" - Mandatory. Groups ents by their application-defined type. Taken from the msg head `typ` (empty = untyped / single-type app).
2. "pid" (parent ID) - Optional. Encodes a hierarchy amongst ents. One ent's `pid` is another ent's `eid`.
3. "tags" - Optional `string[]`. Multi-value reverse index (like `pid`, but N:M). Opaque strings; EntDB does not parse semantics. Clients define conventions (e.g. `impl:${btob64(eid)}` for non-exclusive "implements" links, or `time-week-2026W01` for non-hierarchical grouping). Empty strings and duplicates are dropped on apply; omit or `[]` means no tags.

`pid`, `tags`, and the application payload are [msgpack](https://msgpack.org)-encoded in the DIPLOMATIC msg body. `type` is not in the body; it lives on the [msg head](../api/push#message-head-data-structure).

DIPLOMATIC comes with an EntDB implementation on IndexedDB for use in web browsers. Within IndexedDB, a live ent looks like this:

```
interface IStoredEntity<T = unknown> {
  bod: T; // N bytes
  crd: Date; // createdAt, 8 bytes
  ctr?: number; // 8 bytes
  eid: string; // Typical EID has 8 random bytes + 6 bytes for embedded timestamp = 14 bytes. Base64-encoded in IndexedDB, which expands it to 19 bytes unpadded.
  pid?: string; // 19 bytes (see eid comment above).
  tgs?: string[]; // tags (API); multiEntry-indexed; each tag is a separate index entry.
  typ: string; // T bytes
  upd: Date; // updatedAt, 8 bytes
}

// Permanent delete tombstone (same object store). Omits typ so type indexes skip it.
interface IStoredTomb {
  eid: string;
  upd: Date;
  ctr?: number;
}

type IStoredRow<T = unknown> = IStoredEntity<T> | IStoredTomb;
```

An ent in IndexedDB takes variable amounts of storage based on what attributes it has set. The minimum-size ent will have a ctr of 0 which is omitted, no pid, no tgs, an N-byte body, and a T-byte type. That ent will consume N + 8 + 19 + T + 8 = 35 + N + T bytes of storage in IndexedDB, plus 3 bytes for each attribute name, costing 15 more bytes, for a total of 50 + N + T bytes of storage. That's the minimum.

A maximum-size ent will have all attributes defined. Attribute name overhead scales with which optional fields are set; tgs add the array payload plus multiEntry index entries.

EntDB provides the following indexes for efficient ent lookup:

1. [`typ`, `crd`],
2. [`typ`, `upd`],
3. [`typ`, `pid`],
4. `tgs` (multiEntry) — lookup by exact tag, then filter by `typ`.

**Tag reverse lookup** is the multi-value analogue of `pid`. `getEntities({ type, tag })` returns ents of that type whose `tags` array matches `tag`:

- `tag: string` — exact.
- `tag: { range: { start, end, excludeStart?, excludeEnd? } }` — lexicographic range (inclusive by default). `start > end` yields `InvalidParam`.
- `tag: { prefix: string }` — `startsWith`. Empty prefix matches nothing.

Memory EntDB keeps a secondary map `type → tag → eid` (exact is a map hit; range/prefix scan tag keys — Map order is insertion, not sorted). IndexedDB uses a multiEntry index on `tgs` only (IndexedDB forbids multiEntry with a compound key path): `IDBKeyRange.only` / `bound`, then filter `typ` in application code. One ent can have two tags in a range or prefix, so results are deduped by eid. Prefer unique-ish client encodings (e.g. eid-backed `impl:…` tags) so the exact-tag bucket stays small.

Range order is **string** order, not calendar semantics. Clients that want week/day spans must encode tags so lexicographic order matches (prefix + fixed-width fields), e.g. `time-week-2026W01` … `time-week-2026W12`. Prefix `"time-week-"` lists all such tags.

**updatedAt lookup** uses the compound index `[typ, upd]`. `getEntities({ type, updatedAt })` matches that type by last-write time:

- `updatedAt: Date` — exact millisecond.
- `updatedAt: { range: { start, end, excludeStart?, excludeEnd? } }` — inclusive by default. `start > end` yields `InvalidParam`.

Memory EntDB scans the type bucket and filters. IndexedDB uses `IDBKeyRange.only` / `bound` on `[typ, upd]`.

Query surface (v1): one secondary key per query — `{ type }`, `{ type, pid }`, `{ type, tag }` (exact / range / prefix), or `{ type, updatedAt }` (exact / range). Compound combinations (e.g. pid + tag) are not supported.

Example client convention (not enforced by EntDB):

```ts
// containment (exclusive parent) + contribution (N:M implements)
entity.pid = projectEid;
entity.tags = [`impl:${btob64(objectiveEid)}`];
const implementers = await entDB.getEntities({
  type: "goal",
  tag: `impl:${btob64(objectiveEid)}`,
});
```

Use `btob64` / package helpers so binary eids encode stably across platforms.

### In-memory cache (optimistic apply)

`openEntDB()` wraps IndexedDB in an in-memory cache (`CachedEntDB`). On `apply`:

1. Patch mem **synchronously**.
2. Queue persist to IndexedDB on the write chain (immediately).
3. Notify type subscribers on a microtask (UI still updates before IDB completes).
4. Reconcile those eids from durable; notify again only if mem moved.

`apply` is not `async`: an `await` before the mem patch would stall the save. Notify is deferred a microtask so list watchers cannot run ahead of persist (a cold `getEntities` would otherwise load the whole type from IDB first). Local writes (`insert` / `update` / `delete`) start `state.apply` before awaiting the message archive. Pass `{ optimistic: false }` to skip 1 and 3 and notify only after step 4. The sync worker opens `{ cache: false }` (durable only).

### Frontier checksum

EntDB can compute a **frontier checksum** of all rows — live ents and permanent delete tombstones (not bodies): for each row, encode `eid`, `updatedAt`, and `ctr`, then hash the sorted set of those encodings (`checksumSet`). Tombstones are never pruned: out-of-order message application after partition heal would otherwise resurrect deleted ents.

```ts
const [digest, st] = await entDB.checksum(crypto);
// WorkerClient (optional): await client.entcheck();
```

Use with `client.msgcheck()` to distinguish “archives match but derived state does not” from incomplete sync. To re-derive ents from the msg archive after an applier change, call `client.rebuild()`. Details: [Client API](../api/client#checksums).

### Bags

The DIPLOMATIC relays messages via untrusted hosts. To secure messages when on hosts, DIPLOMATIC wraps them in bags, as in "diplomatic bags" immune from inspection. [Laws of Man](https://www.state.gov/diplomatic-pouches) secure the contents of diplomatic bags. [Laws of Math](https://datatracker.ietf.org/doc/html/rfc8439) secure the contents of DIPLOMATIC bags.
