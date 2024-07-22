# Client API

- `seed(bytes)`
  - Initialize the client's cryptographic seed (used to derive encryption keys and host authentication keys).
- `join(url)`
  - Register with the host at `url`. See [Auth Architecture](../arch/auth).
- `exit(id)`
  - Stop syncing with the host identified by `id`.
- `exec(op)`
  - Apply an operation, `op`, locally and sync it with the registered host. See [Sync Architecture](../arch/sync).
- `export(filename: string, extension = 'dip')`
  - Export stored operations.
  - The file is an uncompressed ZIP file, containing one file per operation.
  - Each file is named `SHA256.op` where `SHA256` is the hex-encoded sha256 hash of the encrypted operation.
  - The contents of the file is the encrypted operation (msgpack encoded prior to encryption).
- `import(file: File)`
  - Import a set of operations stored in a file of the format described above.
