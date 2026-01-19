# TODOS

ARCH
- handle clock skew (how should client deal with server notice it's skewed)

CLIENT
- split React portion into separate package
- implement import/export

ENTDB
- split EntDB into separate package?
- use eid index to optimize last()
- unit test with fake indexeddb

ERRORS
- return ValStat from openBag
- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)
- prepend status byte to each API response to wire server errors through to client?
- return ValStats from entdb queries

TESTS
- test HTTP client and server together
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM. can provide mock data in JSON (users, bags, ...)
- document tests, refactor, and ensure each serves a purpose
- load test and benchmark everything with 1mm synthesized operations (per-persona)

PERF
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
- check whether the indirection in encodeStruct causes a perf hit
- make a noble-based ICrypto implementation and benchmark against libsodium
