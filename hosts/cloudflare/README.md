# Cloudflare host

## Deploy

```bash
npx wrangler deploy
```

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
