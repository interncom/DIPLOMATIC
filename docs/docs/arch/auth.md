# Authentication Architecture

1. Retrieve host ID from host via `GET /id` endpoint.
2. Deterministically derive Ed25519 key pair from seed mixed with host ID.
3. Register public key with host via `POST /users` endpoint. (May require payment.)
4. For other API calls, send public key in `X-DIPLOMATIC-KEY` header and a signature in `X-DIPLOMATIC-SIG` header. The data to be signed will vary with the request.
- [ ]  Document key pair derivation process.
