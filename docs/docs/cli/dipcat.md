# dipcat

Debugging tool. Sends a DIPLOMATIC op to a host.

## Usage

Run host (see [Deno](../host/deno)), then:

```shell
echo "hello dip2" | DIP_HOST=http://localhost:31337 DIP_SEED=0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF deno run --allow-net --allow-env dipcat.ts
```
