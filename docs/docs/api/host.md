# Host API

- `GET /id`
    - Returns the host ID.
- `POST /users`
    - Registers a user. See [Auth architecture](../arch/auth).
- `POST /ops`
    - Uploads an (encrypted) op.
- `GET /ops/:path`
    - Returns an (encrypted) op.
- `GET /ops?begin=$TIMESTAMP`
    - Returns a list of paths to all ops uploaded beginning at `$TIMESTAMP`.
- `ws://hostURL?key=$PUBKEY`
    - Initiate a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) connection to receive real-time notifications when the host receives a new op.
