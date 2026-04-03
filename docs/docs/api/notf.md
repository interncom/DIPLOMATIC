# NOTF

The NOTF endpoint connects a WebSocket listener to receive real-time notifications when new bags are [PUSH](./push)-ed to the host.

To connect to the NOTF endpoint, a client sends an HTTP request with the `upgrade` header set to `websocket`, and a URL query parameter `t` containing a hex-encoded [authTS](../arch/auth) struct.

If the authentication succeeds, the host will establish a WebSocket connection with the client.

When the host receives new bags for a user via [PUSH](./push) requests, it will send the bag headers over the WebSocket connection to each of that user's connected clients. This allows the clients to skip making [PEEK](./peek) requests, unless they notice a gap in the sequence numbers they have.
