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

## Import/Export

- `export(filename)`
  - Export stored operations to a file.
- `import(file, options)`
  - Import operations from a file and apply them locally.
