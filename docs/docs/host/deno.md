# Deno (Local)

A simple host for local testing.

1. Install [Deno](https://deno.com).
2. `git clone https://github.com/interncom/DIPLOMATIC.git`
3. `cd DIPLOMATIC`
4. `DIPLOMATIC_HOST_ID=id123 DIPLOMATIC_HOST_PORT=3311 DIPLOMATIC_REG_TOKEN=tok123 deno run --allow-env --allow-net --allow-read hosts/deno/server.ts`
5. Point your client at the URL that provides.

NOTE: this host does not currently have persistent storage. It’s all in-memory.
