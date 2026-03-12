# Host API

The DIPLOMATIC protocol has 4 endpoints, plus the [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) channel.

## Endpoints

- [`USER`](./user) Registers a user.
- [`PEEK`](./peek) Fetches bag headers uploaded since provided sequence number SEQ.
- [`PUSH`](./push) Uploads bags.
- [`PULL`](./pull) Fetches a list of bags with provided sequence numbers.
- `wss://hostURL?=<authTSHex>` Initiate a [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) connection to receive new bags in real-time.
    
### Response Header

All API responses (excluding the websocket) begin with a standard response header. It looks like this:

```
export interface IRespHead {
  // Overall status of the request.
  status: Status; // 1 byte

  // NTP-style timestamps for client to compute offset from host clock.
  timeRcvd: Date; // ~6 bytes
  timeSent: Date; // ~6 bytes

  subscription: ISubscriptionMetadata; // ~30 bytes
}
```

Each response includes a status code so the client can know if the request succeeded or if not, why not. The timeRcvd and timeSent timestamps allow the client to determine if it is in-sync with the host's clock, using [NTP](https://www.rfc-editor.org/rfc/rfc958) logic, which can indicate if the client's clock is wrong. The subscription information allows the client to anticipate if it is at risk of losing service from this host, which could compromise data availability, particularly if the client is not maintaining a full message archive.

```
// ~30 bytes.
export interface ISubscriptionMetadata {
  // Duration of subscrption term in milliseconds.
  // 0 indicates an indefinite term (either lifetime or pay-as-you-go).
  term: number;

  // Milliseconds since start of term.
  elapsed: number;

  // "static" usage, i.e. storage.
  stat: IUsageQuota;

  // "dynamic" usage, i.e. time (bandwidth, CPU time, ...).
  dyn: IUsageQuota;
}

export interface IUsageQuota {
  quota: number;
  usage?: number;
}
```

Total size of the response header is about 43 bytes.

## Authentication

Users identify to hosts as the public key portion of an Ed25519 asymmetric keypair.

All endpoints use the same authentication mechanism. We call it authTS, short for "authentication timestamp". An authTS is the current timestamp (from the perspective of the user's client device), signed with user's Ed25519 keypair. The host verifies that:

1. The user's public key is registered in the host's list of users (unless the user is registering for the first time).
2. That the timestamp is close-enough to the server's view of the current time. This is important, because DIPLOMATIC relies on wall clock time for consistent ordering of messages.
3. That the signature is validly produced by the private key corresponding to the user's public key.

This mechanism proves that the user controls the private key of their Ed25519 keypair at the time they made the request. Even if the authTS is snooped, it will only work if replayed quickly.

### AuthTS Data Structure

|Field|Bytes|Encoding|
|-----|-----|--------|
|pubKey|32|raw bytes|
|sig|64|raw bytes|
|ts|5-8|var-int milliseconds since UNIX epoch|

Total size: 101-104 bytes.
