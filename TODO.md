# TODOS

ARCH
- handle clock skew (how should client deal with server notice it's skewed)
- determine if it's a risk to allow arbitrary labels upon import (could be used to induce client to derive the keys necessary to hack a targeted host). maybe possible to compute only the pubkey without the privkey? could do that all within Enclave at least and only expose the pubKey

CLIENT
- split React portion into separate package?
- implement import/export (eliminate zip dependency)

ENTDB
- split EntDB into separate package?
- use eid index to optimize last()
- unit test with fake indexeddb

ERRORS
- allow a ValStat to hold a list of Status codes, to capture the full stack (err can wrap an err(stat) return val) or is that too implementation specific? maybe better to have a location embedded within the status byte
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
