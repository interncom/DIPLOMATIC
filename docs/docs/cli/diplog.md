# diplog

Debugging tool. Lists DIPLOMATIC ops from a host.

## Usage

Run host (see [Deno](../host/deno)), then:

```shell
DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF deno run --allow-net --allow-env diplog.ts
```
