# Client API

## App setup (with or without React)

```ts
import {
  openEntDB,
  entStateManager,
  openDiplomaticClient,
} from "@interncom/diplomatic";

const entDB = await openEntDB(); // cache on by default
// const entDB = await openEntDB({ cache: false }); // durable IDB only
const state = entStateManager(entDB);
const { client, dispose } = await openDiplomaticClient({ state, worker });
```

## Client State

- `setSeed(seed)`
  - Initialize the client's cryptographic seed (used to derive encryption keys and host authentication keys).
- `wipe()`
  - Wipe all local data and disconnect from hosts.
  
## Hosts

- `sync()`
  - Synchronize with all connected hosts.
- `link(host)`
  - Register with a host. See [Auth Architecture](../arch/auth).
- `unlink(label)`
  - Stop syncing with the host identified by `label`.
- `connect(listen)`
  - Establish active connections to all linked hosts.
- `disconnect()`
  - Disconnect from all hosts.

## Data

Local writes build a message, optimistically apply it to the in-memory EntDB cache (when used), then durable-apply the **same** message through the sync pipeline (archive → exec → upload).

Shared fields on write ops (msgpack body of the ent):

```ts
type EntFields<T> = {
  type: string;       // application type name
  body?: T;           // application payload
  gid?: string;       // optional group id
  pid?: EntityID;     // optional parent eid (exclusive hierarchy)
  tags?: string[];    // optional multi-value reverse-indexed tags (N:M refs)
};
```

`tags` are opaque strings (exact match). EntDB multiEntry-indexes them for reverse lookup via `getEntities({ type, tag })` — same performance model as `pid` reverse lookup, but multi-value. Clients define conventions (e.g. `impl:${btob64(eid)}`). Empty strings and duplicates are dropped on apply.

A [rev](../about/glossary#rev) is the latest observed identity of an ent:

```ts
type IEntRev = {
  eid: EntityID;
  ctr: number;
  updatedAt: Date;  // last-write time of this rev
};
// From a loaded ent: revFromEntity(ent)
// From a returned msg head: revFromHead(head)
```

### Methods

All writes take a single opts object (`force` optional where skew can apply).

- `genEID(id?)` — allocate a new entity id (optional 8-byte id material).

- `insert(op)` — create a new ent (new eid, ctr 0).

  ```ts
  op: EntFields<T> & { id?: Uint8Array }  // id = optional eid material
  ```

- `update(op)` **(preferred for edits)** — next ctr is `prior.ctr + 1`; no archive I/O.

  ```ts
  op: EntFields<T> & {
    prior: IEntRev;
    force?: boolean;  // clock-skew recovery; default client-wide
  }

  await client.update({
    prior: revFromEntity(ent),
    type: "todo",
    body: { text: "milk", done: true },
  });
  ```

- `delete(op)` — by prior (preferred) or eid (archive lookup).

  ```ts
  type IDeleteParams =
    | { prior: IEntRev; force?: boolean }  // preferred
    | { eid: EntityID; force?: boolean };  // loads prior from archive

  await client.delete({ prior: revFromEntity(ent) });
  await client.delete({ eid: ent.eid }); // slower
  ```

## Rebuild

- `rebuild(options?)` — wipe application state (e.g. EntDB) and re-derive it by replaying the local message archive.

  ```ts
  await client.rebuild();                    // default: inventory hosts first
  await client.rebuild({ checkHost: false }); // local archive only
  ```

  By default (`checkHost: true`), each linked host is peeked from sequence 0 so any bags missing from the local archive are pulled before replay. Use this after an applier/schema change when msgs are correct but derived ents are wrong. Does **not** wipe the message archive, seed, or hosts.

  With a sync worker, rebuild runs on the worker (network + EntDB apply off the main thread).

## Checksums

Digests for comparing archives and LWW frontiers across devices. Both use the same set construction: **blake3(concat(sort_lex(byte records)))**. Empty set → blake3 of empty input.

### `msgcheck()` — message archive

- `msgcheck()` → `Hash` (32-byte blake3 digest)

  Checksum of the **set of msg head hashes** (archive keys). Keys are decoded to raw bytes (store encoding such as base64 IDB keys is irrelevant), sorted lexicographically, concatenated, then hashed.

  ```ts
  const a = await clientA.msgcheck();
  const b = await clientB.msgcheck();
  // equal digests ⇒ same set of msgs locally
  ```

  With a sync worker, runs off the main thread.

### EntDB frontier — `checksum` / `entcheck`

Not a content hash of bodies. Fingerprints **live** ents only (deletes are absent): each row as `eid ‖ updatedAt ‖ ctr` (varbytes eid, date as ms varint, ctr varint), then the same set-checksum as above.

- `entDB.checksum(crypto)` → `ValStat<Hash>` — primary API; works on any `IEntDB` (memory, IDB, cached). Cached EntDB checksums the durable store, not a partial in-memory cache.

  ```ts
  import { crypto } from "@interncom/diplomatic";
  const [digest, st] = await entDB.checksum(crypto);
  ```

- `WorkerClient.entcheck()` → `Hash` — same digest via the sync worker (off main). Not on `IClient` / `SyncClient` (those have no EntDB handle); call `entDB.checksum(crypto)` on the main-thread path.

### Interpreting digests

| `msgcheck` | Ent frontier | Meaning |
|------------|--------------|---------|
| equal | equal | Archives and LWW frontiers agree |
| equal | differ | Same msgs, wrong derived state → `rebuild()` |
| differ | * | Archives diverge → sync / `rebuild({ checkHost: true })` |

## Import/Export

- `export(filename)`
  - Export stored operations to a file.
- `import(file, options)`
  - Import operations from a file and apply them locally.
