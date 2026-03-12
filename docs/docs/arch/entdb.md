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

These are [msgpack](https://msgpack.org)-encoded within the DIPLOMATIC msg body. The rest of the ent data lives alongside those, encoded the same way.

DIPLOMATIC comes with an EntDB implementation on IndexedDB for use in web browsers. Within IndexedDB, an ent looks like this:

```
interface IStoredEntity<T = unknown> {
  bod: T; // N bytes
  crd: Date; // createdAt, 8 bytes
  ctr?: number; // 8 bytes
  eid: string; // Typical EID has 8 random bytes + 6 bytes for embedded timestamp = 14 bytes. Base64-encoded in IndexedDB, which expands it to 19 bytes unpadded.
  gid?: string; // G bytes.
  pid?: string; // 19 bytes (see eid comment above).
  typ: string; // T bytes
  upd: Date; // updatedAt, 8 bytes
}
```

An ent in IndexedDB takes variable amounts of storage based on what attributes it has set. The minimum-size ent will have a ctr of 0 which is omitted, no gid, no pid, an N-byte body, and a T-byte type. That ent will consume N + 8 + 19 + T + 8 = 35 + N + T bytes of storage in IndexedDB, plus 3 bytes for each attribute name, costing 15 more bytes, for a total of 50 + N + T bytes of storage. That's the minimum.

A maximum-size ent will have all attributes defined. That will cost 24 bytes for the 8 attribute names, plus N + 8 + 8 + 19 + G + 19 + T + 8 bytes, for a total of 86 + N + G + T bytes.

EntDB provides the following composite indexes for efficient ent lookup:

1. [`typ`, `crd`],
2. [`typ`, `upd`],
3. [`typ`, `pid`].
4. [`typ`, `gid`].

### Bags

The DIPLOMATIC relays messages via untrusted hosts. To secure messages when on hosts, DIPLOMATIC wraps them in bags, as in "diplomatic bags" immune from inspection. [Laws of Man](https://www.state.gov/diplomatic-pouches) secure the contents of diplomatic bags. [Laws of Math](https://datatracker.ietf.org/doc/html/rfc8439) secure the contents of DIPLOMATIC bags.
