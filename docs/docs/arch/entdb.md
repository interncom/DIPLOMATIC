# EntDB (Entity Database)

##  Protocol Layers

### Msgs (Messages)

The atomic unit of the DIPLOMATIC protocol is the message, abbreviated msg. A message is an update (insert, update, or delete) to an application data object. Each message carries with it the complete state of the object, as well as metadata necessary to achieve consistent ordering of messages, to achieve an eventually consistent state of application data objects across all devices.

### Ents (Entities)

In DIPLOMATIC, we call these application data objects "ents", short for "entities". As applications receive new messages, they update their entities to reflect the latest state of each application data object encoded in the messages.

EntDB adds concepts on top of the raw DIPLOMATIC protocol:

1. "type" - Mandatory. Groups ents by their application-defined type.
2. "pid" (parent ID) - Optional. Encodes a hierarchy amongst ents. One ent's `pid` is another ent's `eid`.
3. "gid" (group ID) - Optional. Supports non-hierarchical grouping, e.g. by date.
4. "tags" - Optional `string[]`. Multi-value reverse index (like `pid`, but N:M). Opaque strings; EntDB does not parse semantics. Clients define conventions (e.g. `impl:${btob64(eid)}` for non-exclusive "implements" links). Empty strings and duplicates are dropped on apply; omit or `[]` means no tags.

These are [msgpack](https://msgpack.org)-encoded within the DIPLOMATIC msg body. The rest of the ent data lives alongside those, encoded the same way.

DIPLOMATIC comes with an EntDB implementation on IndexedDB for use in web browsers. Within IndexedDB, a live ent looks like this:

```
interface IStoredEntity<T = unknown> {
  bod: T; // N bytes
  crd: Date; // createdAt, 8 bytes
  ctr?: number; // 8 bytes
  eid: string; // Typical EID has 8 random bytes + 6 bytes for embedded timestamp = 14 bytes. Base64-encoded in IndexedDB, which expands it to 19 bytes unpadded.
  gid?: string; // G bytes.
  pid?: string; // 19 bytes (see eid comment above).
  tags?: string[]; // multiEntry-indexed; each tag is a separate index entry.
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

An ent in IndexedDB takes variable amounts of storage based on what attributes it has set. The minimum-size ent will have a ctr of 0 which is omitted, no gid, no pid, no tags, an N-byte body, and a T-byte type. That ent will consume N + 8 + 19 + T + 8 = 35 + N + T bytes of storage in IndexedDB, plus 3 bytes for each attribute name, costing 15 more bytes, for a total of 50 + N + T bytes of storage. That's the minimum.

A maximum-size ent will have all attributes defined. Attribute name overhead scales with which optional fields are set; tags add the array payload plus multiEntry index entries.

EntDB provides the following indexes for efficient ent lookup:

1. [`typ`, `crd`],
2. [`typ`, `upd`],
3. [`typ`, `pid`],
4. [`typ`, `gid`],
5. `tags` (multiEntry) — lookup by exact tag, then filter by `typ`.

**Tag reverse lookup** is the multi-value analogue of `pid`: `getEntities({ type, tag })` returns ents of that type whose `tags` array includes the tag. Memory EntDB keeps a secondary map `type → tag → eid`; IndexedDB uses a multiEntry index on `tags` only (IndexedDB forbids multiEntry with a compound key path), so the type filter runs in application code after the tag index hit. Prefer unique-ish client encodings (e.g. eid-backed `impl:…` tags) so the tag bucket stays small.

Query surface (v1): one secondary key per query — `{ type }`, `{ type, pid }`, `{ type, gid }`, `{ type, tag }`, or `{ type, updatedBetween }`. Compound combinations (e.g. pid + tag) are not supported.

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

### Frontier checksum

EntDB can compute a **frontier checksum** of all rows — live ents and permanent delete tombstones (not bodies): for each row, encode `eid`, `updatedAt`, and `ctr`, then hash the sorted set of those encodings (`checksumSet`). Tombstones are never pruned: out-of-order message application after partition heal would otherwise resurrect deleted ents.

```ts
const [digest, st] = await entDB.checksum(crypto);
// WorkerClient (optional): await client.entcheck();
```

Use with `client.msgcheck()` to distinguish “archives match but derived state does not” from incomplete sync. To re-derive ents from the msg archive after an applier change, call `client.rebuild()`. Details: [Client API](../api/client#checksums).

### Bags

The DIPLOMATIC relays messages via untrusted hosts. To secure messages when on hosts, DIPLOMATIC wraps them in bags, as in "diplomatic bags" immune from inspection. [Laws of Man](https://www.state.gov/diplomatic-pouches) secure the contents of diplomatic bags. [Laws of Math](https://datatracker.ietf.org/doc/html/rfc8439) secure the contents of DIPLOMATIC bags.
