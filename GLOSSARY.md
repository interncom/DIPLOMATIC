`kdm` stands for key derivation material.

A suffix of "cph", e.g. `headCph`, indicates that the variable is encrypted.

A suffix of "enc", e.g. "envEnc", indicates that the variable is encoded (binary-encoded).

"msg" is short for "message".

`enc` stands for "encoder".

`dec` stands for "decoder".

`deriv` is short for "derivation".

TODOS:
- deduplicate the keypair generation that happens in each client method and also in timestampAuthProof
- refactor sigProof. maybe just combine with tsAuth and inline that all in client.ts

- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)

- get client.register using same dec = post(url, enc) pattern as the rest
- make getHostID use same tsAuth pattern as rest? host could theoretically return a different ID for each client which would be fine if consistent. this would allow a kind of key exchange. it's a rare call so the extra overhead is negligble. seems good

- refactor so that HTTP layer is separate and built on top of protocol layer (protocol itself doesn't care about URLs and HTTP response codes)
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM
- mock clock and storage and test server protocol handlers

- make a Clock abstraction rather than passing now to each client method
- server can use Clock abstraction too. use it to make tests of clocks out of sync

- add tests for PUSH, PEEK, and PULL that round-trip a couple envelopes and check their contents
- index envelopes with a per-user SEQ on host, and use that for PEEK responses and PULL requests (with varints, saves almost 32 bytes per envelope until very large numbers of envelopes)

- use generators (yield) as return values from client methods rather than accumulating arrays
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
