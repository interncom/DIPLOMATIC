# Client API

- `seed(bytes)`
  - Initialize the client's cryptographic seed (used to derive encryption keys and host authentication keys).
- `join(url)`
  - Register with the host at `url`. See [Auth Architecture](../arch/auth).
- `exit(id)`
  - Stop syncing with the host identified by `id`.
- `exec(op)`
  - Apply an operation, `op`, locally and sync it with the registered host. See [Sync Architecture](../arch/sync).
