# TODOS

ARCH
- split ProtoClient from HttpClient and do same for server. HttpServer handles CORS, routing, response codes, but that's it. Maybe should even use a preliminary byte for routing (API method selection)

ERRORS
- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)
- error handling for decoders

TESTS
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM
- add tests for PUSH, PEEK, and PULL that round-trip a couple bags and check their contents
- document tests, refactor, and ensure each serves a purpose

TIME
- server can use Clock abstraction too. use it to make tests of clocks out of sync

PERF
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
- check whether the indirection in encodeStruct causes a perf hit
- make a noble-based ICrypto implementation and benchmark against libsodium
