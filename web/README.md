# STATUS app

Demo of DIPLOMATIC sync protocol. Syncs a status message.

## Password Manager Seed Storage

Host over HTTPS, then Firefox and Safari will prompt to save password. It is necessary for the user to type something in the username field to trigger this.

### Local Testing

1. (Optional) Install `mkcert` for generating a self-signed certificate.
1. (Optional) `mkcert localhost` to generate the certs (already commited to repo).
1. `npm run dev:https` to start Vite's server, using those certificates.
