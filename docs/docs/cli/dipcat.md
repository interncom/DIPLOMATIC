# `dipcat`

## Description

`dipcat` sends ops to a host. See https://github.com/interncom/DIPLOMATIC/tree/master/tools/dipcat.

## Usage

```shell
echo '{ "ts": "2024-06-28T02:30:03.971Z", "verb": "UPSERT", "ver": 0, "type": "count", "body": 43 }' | \
DIPLOMATIC_HOST_URL=https://diplomatic-cloudflare-host.root-a00.workers.dev \
DIPLOMATIC_SEED_HEX=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF \
deno run --allow-net --allow-env tools/dipcat/dipcat.ts
```
