# Cloudflare

It works.

- [ ]  Document this better.

For now, peek around the `hosts/cloudflare` directory. The code is largely shared with the Deno host. Currently storing everything in D1.

- [ ]  Store (encrypted) ops in R2, indexed by D1.
- [x]  Use Durable Objects to notify client of new data via websocket? Need to replace polling.
