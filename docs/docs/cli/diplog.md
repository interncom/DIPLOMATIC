# `diplog`

## Description

 `diplog` fetches all the ops from a host and prints them to the command line. See https://github.com/interncom/DIPLOMATIC/tree/master/tools/diplog.

## Usage

```shell
DIPLOMATIC_HOST_URL=https://diplomatic-cloudflare-host.root-a00.workers.dev \
DIPLOMATIC_SEED_HEX=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF \
deno run --allow-net --allow-env tools/diplog/diplog.ts
```
