# dipcat

Debugging tool. Sends a DIPLOMATIC op to a host.

## Usage

`DIPLOMATIC_HOST_URL=https://diplomatic-cloudflare-host.root-a00.workers.dev DIPLOMATIC_SEED_HEX=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF deno run --allow-net --allow-env dipcat.ts < example.json`