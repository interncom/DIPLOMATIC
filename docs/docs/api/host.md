# Host API

The DIPLOMATIC protocol has 4 endpoints, plus the [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) channel.

## Endpoints

- `USER`
    - Registers a user. See [Auth architecture](../arch/auth).
- [`PEEK`](./peek)
    - Fetches bag headers uploaded since provided sequence number SEQ.
- [`PUSH`](./push)
    - Uploads bags.
- [`PULL`](./pull)
    - Fetches a list of bags with provided sequence numbers.
- `wss://hostURL?=<authTSHex>`
    - Initiate a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) connection to receive new bags in real-time.

## Authentication

Users identify to hosts as the public key portion of an Ed25519 asymmetric keypair.

All endpoints use the same authentication mechanism which we call authTS, short for "authentication timestamp". An authTS is the current timestamp (from the perspective of the user's client device), signed with user's Ed25519 keypair. The host verifies that:

1. The user's public key is registered in the host's list of users (unless the user is registering for the first time).
2. That the timestamp is close-enough to the server's view of the current time.
3. That the signature is validly produced by the private key corresponding to the user's public key.

This mechanism proves that the user controls the private key of their Ed25519 keypair at the time they made the request. Even if the authTS is snooped, it will only work if replayed quickly.

### AuthTS Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|pubKey|32|raw bytes|
|sig|64|raw bytes|
|ts|5-8|var-int milliseconds since UNIX epoch|

Total size: 101-104 bytes.
