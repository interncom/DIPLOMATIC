# status

Demo CLI. `write`, `read`, and `watch` talk to a host and keep nothing on disk.
`app` stays up like `watch` and keeps status ents in a local folder.

## Stateless

`DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run write.ts "my status"`

`DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run read.ts`

`DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run watch.ts`

## App

The folder is `DIP_DIR` (default `.status` in the current directory). It holds
`meta.sqlite`, `data-<acct>.sqlite`, `ents-<acct>.sqlite`, and `blobs/`. The
master seed stays in `DIP_SEED`. A later YubiKey bind will fill the account
row's keyring column.

`DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF bun run app.ts`
