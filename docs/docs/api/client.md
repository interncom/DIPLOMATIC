# Client API

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

- `genEID(id)`
  - Generate a new entity ID.
- `insert(op)`
  - Apply an insert operation locally and sync it with registered hosts.
- `upsert(op, force)`
  - Apply an upsert operation locally and sync it with registered hosts.
- `delete(eid)`
  - Delete an entity locally and sync it with registered hosts.
  
## Import/Export

- `export(filename)`
  - Export stored operations to a file.
- `import(file, options)`
  - Import operations from a file and apply them locally.
