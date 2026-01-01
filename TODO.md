# TODOS

ARCH
- let hosts maintain multiple ID keys to mitigate loss risk (could be Schnorr signatures or just a list of Ed25519 public keys that host may use)

ERRORS
- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)
- error handling for decoders

TESTS
- refactor so that HTTP layer is separate and built on top of protocol layer (protocol itself doesn't care about URLs and HTTP response codes)
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM
- mock clock and storage and test server protocol handlers
- add tests for PUSH, PEEK, and PULL that round-trip a couple bags and check their contents

TIME
- make a Clock abstraction rather than passing now to each client method
- server can use Clock abstraction too. use it to make tests of clocks out of sync

PERF
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
- check whether the indirection in encodeStruct causes a perf hit
- make a noble-based ICrypto implementation and benchmark against libsodium
