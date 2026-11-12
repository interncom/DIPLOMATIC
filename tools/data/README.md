# DATA

The DATA app syncs data for a given app from a given host and stores it locally.

Specify the app's name using the `--app` flag. This will determine which
directory the application data (SQLite + blobs) is stored in. The data dir
holds `meta.sqlite`, `data-<acct>.sqlite`, `ents-<acct>.sqlite`, and `blobs/`.

Specfiy the host URL with the `--host` flag.

When you first run the app, complete the pairing to load the key.

This tool imports `@interncom/diplomatic/bun` for the disk store and YubiKey
ring, and `@interncom/diplomatic/web` for `SyncClient` and the pairing helpers.
Both ship in one package. The Bun client is not the host. Build from `pkg/`,
then `bun install` from `tools/data/`.

## Usage

```
bun run tools/data/data.ts --host http://localhost:31337 --app status
bun run tools/data/data.ts --host http://localhost:31337 --app status accept
```

The first run prints `DHKEReq`, reads `DHKEResp`, binds the YubiKey, links the
host, and stays up syncing. A later run unlocks that key and syncs. `accept`
types `yes` on the terminal, prints `DHKEResp`, then syncs. `--non-resident`
skips a discoverable credential on the first bind.
