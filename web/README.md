# STATUS app

Demo of DIPLOMATIC sync protocol. Syncs a status message.

## Password Manager Seed Storage

Host over HTTPS, then Firefox and Safari will prompt to save password. It is necessary for the user to type something in the username field to trigger this.

### Local Testing

1. Install `mkcert` for generating a self-signed certificate.
1. `mkcert localhost` to generate the certs (already commited to repo).
1. `mkcert -install` to trust the cert (or manually trust).
1. `npm run dev:https` to start Vite's server, using those certificates.
1. `DIPLOMATIC_HOST_ID=id123 DIPLOMATIC_HOST_PORT=3311 DIPLOMATIC_REG_TOKEN=tok123 deno run --allow-env --allow-net --allow-read src/server.ts --https` to run the backend using those certs.
