# Deno (Local)

A simple host for local testing.

1. Install [Deno](https://deno.com).
2. `git clone https://github.com/interncom/DIPLOMATIC.git`
3. `cd DIPLOMATIC`
4. `DIPLOMATIC_HOST_ID=id123 DIPLOMATIC_HOST_PORT=3311 DIPLOMATIC_REG_TOKEN=tok123 deno run --allow-env --allow-net --allow-read --allow-write hosts/deno/server.ts --https`
5. Point your client at the URL that provides.

This host stores data to a SQLite database named `diplomatic.db`.
The demo projects in the git repo point at this host (`https://localhost:3311`). You may need to configure your system to accept the certificates at `certs/`.
