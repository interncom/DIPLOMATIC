# TODOS

CLIENT
- split React portion into separate package
- implement import/export
- eliminate idb library dependency

ERRORS
- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)
- error handling for decoders

TESTS
- test HTTP client and server together
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM. can provide mock data in JSON (users, bags, ...)
- document tests, refactor, and ensure each serves a purpose

PERF
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
- check whether the indirection in encodeStruct causes a perf hit
- make a noble-based ICrypto implementation and benchmark against libsodium
