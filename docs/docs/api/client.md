# Client API

## App setup (with or without React)

```ts
import {
  openEntDB,
  entStateManager,
  openDiplomaticClient,
} from "@interncom/diplomatic";

const entDB = await openEntDB(); // cache + optimistic UI notify (default)
// const entDB = await openEntDB({ optimistic: false }); // notify after durable
// const entDB = await openEntDB({ cache: false }); // durable IDB only
// const entDB = await openEntDB({ verbose: true }); // [dip] apply/list/persist timings
const state = entStateManager(entDB);
// worker: true → library spawns embedded sync Worker (only supported path)
const { client, dispose } = await openDiplomaticClient({ state, worker: true });
// openDiplomaticClient({ state, worker: true, verbose: true }) — same traces
// useClient({ worker: true, verbose: true }) — same
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

Local writes build a message and call `state.apply` **before** the persist queue, the apply chain, and the message archive. With the default EntDB cache, `apply` patches mem immediately, queues IndexedDB persist, then notifies UI subscribers after the next paint (before IDB callbacks). That lets a fire-and-forget save close its modal in the current frame; a prior write's archive/persist cannot delay the notify. Pass `{ optimistic: false }` to notify only after that durable commit. Archive → mark applied → upload still run after.

Shared fields on write ops. `type` is stored on the msg head (`typ`). The msg body is an ordered frame: optional `pid` (var-bytes; empty means absent), a var-int tag count, that many var-strings, then the raw `body` bytes. The app encodes `body`.

```ts
type EntFields = {
  type: string;       // application type name (msg head typ)
  body?: Uint8Array;  // application payload
  pid?: EntityID;     // optional parent eid (exclusive hierarchy)
  tags?: string[];    // optional multi-value reverse-indexed tags (N:M refs)
};
```

`tags` are opaque strings. EntDB multiEntry-indexes them for reverse lookup via `getEntities({ type, tag })` — same performance model as `pid` reverse lookup, but multi-value. `tag` is an exact string, `{ range: { start, end, excludeStart?, excludeEnd? } }` (lexicographic, inclusive by default), or `{ prefix }`. Range `start > end` returns `InvalidParam`. Clients define conventions (e.g. `impl:${btob64(eid)}`, `time-week-2026W01`). Empty strings and duplicates are dropped on apply.

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

### Blobs

A blob is an ent whose payload is the bytes. The head `typ` is `blob:` plus a mime (`blob:image/jpeg`). The ent body is the same ordered frame as any other ent, and the raw bytes are its `body`. Another ent stores the blob's full `eid`. A filename goes in `tags`. These writes return `ValStat`, the same `[value, status]` pair as `insert` and `update`.

Most blobs have one referring ent. Set the blob's `pid` to that ent's `eid`, as in the insert below. Clock-skew recovery can replace the blob eid and leave the stored reference broken. The `pid` still names the referrer, so a later pass can list the blobs parented there and point the reference at the live one. The same link finds a blob the referrer dropped. A rich-text field that removes an embedded image can see the blob still parented to that note and call `deleteBlob`.

- `insertBlob(mime, bytes, opts?)` — new blob ent. `mime` is the part after `blob:`, such as `"image/jpeg"`. An empty mime is `InvalidParam`. `opts` is `{ pid?, tags? }`. An empty `Uint8Array` is still a live blob.

  ```ts
  import { Status } from "@interncom/diplomatic";

  const bytes = new Uint8Array(await file.arrayBuffer());
  const [head, st] = await client.insertBlob("image/jpeg", bytes, {
    pid: note.eid,
    tags: ["name:cat.jpg"],
  });
  if (st !== Status.Success) return;
  // head.eid — store this on the ent that owns the file
  ```

- `updateBlob(eid, bytes, opts?)` — replace the bytes of an existing blob. `opts` is `{ pid?, tags?, mime? }`. A present key replaces the archived value. A missing key keeps it. `tags: []` clears tags. A present `pid: undefined` clears the parent. Omit `mime` to keep the previous type. An empty `mime` is `InvalidParam`.

  `NotFound` when `eid` has no message, or the latest message is a delete. `InvalidParam` when that message has no blob mime. Skew recovery follows `update`.

  ```ts
  const [head, st] = await client.updateBlob(blobEid, nextBytes, {
    mime: "image/webp",
    tags: ["name:cat.webp"],
  });
  ```

- `deleteBlob(eid)` — delete that ent. Same as `delete({ eid })`. The archived bytes stay until message pruning exists. A later `readBlob` or `updateBlob` is `NotFound`.

- `readBlob(eid)` — a copy of the latest bytes. `NotFound` when `eid` is missing, the latest message is a delete, or it is not a blob. A live blob with an empty payload returns an empty `Uint8Array`.

  ```ts
  const [bytes, st] = await client.readBlob(blobEid);
  if (st !== Status.Success) return;
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

## Apply diagnostics

Each archived msg has an apply lifecycle state (`apld`):

| Value | Constant | Meaning |
|-------|----------|---------|
| `"f"` | `APLD_PENDING` | stored, not yet successfully applied (also transient storage errors) |
| `"t"` | `APLD_APPLIED` | exec succeeded (`Success` / `NoChange`) |
| `"e"` | `APLD_ERROR` | terminal apply failure; `err` holds a `Status` code |

Use these when digests disagree or the app looks out of sync:

- `countMsgs(apld?)` → number of msgs (optional filter). Prefer over list+length for badges.
- `listMsgs(opts?)` → enumerate msgs for inspection.
  - `opts.apld` — filter (e.g. `APLD_ERROR` for poison msgs, `APLD_PENDING` for stuck drain)
  - `opts.body` — include payloads and derive `head.hsh` (**default `true`**). Pass `body: false` for lighter listings (`body`/`hsh` omitted; `head.len` still reflects stored size).

```ts
import { APLD_ERROR, Status } from "@interncom/diplomatic";

const n = await client.countMsgs(APLD_ERROR);
if (n > 0) {
  const failed = await client.listMsgs({ apld: APLD_ERROR });
  for (const m of failed) {
    console.warn(Status[m.err ?? 0], m.head.ctr, m.hash);
    // m.body present by default — decode as needed
  }
  // Badge / head-only scan:
  const light = await client.listMsgs({ apld: APLD_ERROR, body: false });
}
// After fixing the applier/schema:
await client.rebuild();
```

With a sync worker, list/count read the shared message archive on the main thread (no worker RPC).

## Host reconcile

Host **bag** count and client **msg** count are different metrics: bags are per-seq envelopes on the host; msgs are the distinct changes in a client archive (archive key = hash of the encoded msg). A host can hold duplicate bags for the same msg and/or be missing msgs the client has.

- `reconcile(hostLabel, opts?)` → `ValStat<ReconcileReport>`
  - Full PEEK from seq 0 (inventory); advances `lastSeq` on the host row.
  - Returns **ephemeral** `{ msgcheck, numBags, numDupes }` (not stored). With default `sync: true`, after drain + re-inventory. `msgcheck` is the set of distinct msgs on the host (same construction as `msgcheck()`).
  - `opts.pull` (default **true**): enqueue downloads for msgs on the host missing locally.
  - `opts.push` (default **false**): enqueue uploads for local archive msgs missing on the host.
  - `opts.sync` (default **true**): run `sync()` afterward so queues drain, then re-inventory. Pass `sync: false` for inventory-only.
  - Cancels debounced sync and waits for in-flight `sync()` before inventory (same as `rebuild`).

```ts
const [report, st] = await client.reconcile("primary", {
  pull: true,
  push: true,
});
// report.msgcheck, report.numBags, report.numDupes — keep in app state if needed
const localCheck = await client.msgcheck();
// report.msgcheck equals localCheck ⇒ same set of msgs
```

`numDupes` is the number of **extra** bags beyond one bag per msg (`Σ max(0, bags_for_msg − 1)`).

## Import/Export

- `export(filename)`
  - Export stored operations to a file.
- `import(file, options)`
  - Import operations from a file and apply them locally.
