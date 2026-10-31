# Cloudflare host

## Deploy

```bash
npx wrangler deploy
```

## Object storage

Bodies over 1 MiB live in R2 bucket `diplomatic-blobs` (binding `DIP_BLOBS`). Create it once before the first deploy that includes this binding:

```bash
npx wrangler r2 bucket create diplomatic-blobs
```

D1 still indexes every bag. `headCph` stays in the `bags` row. `bodyKey` is the R2 object name when the body is not inline. In case of a failed put, no row is inserted into the SQL database and the push item in the response for that row indicates a `StorageError`.

CAUTION: Re-running `schema.sql` drops `bags`.

## Database

### Init / reset tables

```bash
npx wrangler d1 execute diplomatic --remote --file=src/schema.sql
```

For local: use `--local` instead of `--remote`.

### Recreate database

```bash
npx wrangler d1 delete diplomatic
npx wrangler d1 create diplomatic
```

Put the new `database_id` in `wrangler.toml`, then init tables as above.
