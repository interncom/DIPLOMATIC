# TODOS

GENERAL
- deal with eid's as `type EID = { id: Uint8Array, clk: Date }`
- rename fields clk -> t0 for entity creation and off -> dt for offset from creation, also eid -> id, then the true eid becomes [id, t0]
- reconcile IOp and IMessage--are they the same?
- make params to genUpsertHead, etc... be objects rather than positional
- Fix all `// TODO:` in codebase

ARCH
- server reject push with warning (ClockSkew status) in case of skew
- client return status from sync() to surface this
- client override server skewed push rejection with a force flag (update push codec)
- host return NTP timestamps in all responses
- client store host clock offset in hosts table row

- replace host hash with seq
- generalize crypto random bytes function to genRandomBytes(numBytes)
- change updateEnt to return a ValStat<IEntity<T = unknown>>
- use codec in EntDB message body for all but application-specific portion, and for that, use an app-provided codec (msgpack) can avoid msgpack dependency

CLIENT
- determine if it's a risk to allow arbitrary labels upon import (could be used to induce client to derive the keys necessary to hack a targeted host). maybe possible to compute only the pubkey without the privkey? could do that all within Enclave at least and only expose the pubKey
- split React portion into separate package?
- eliminate fileSaver dependency

ENTDB
- split EntDB into separate package?
- use eid index to optimize last()
- unit test with fake indexeddb
- lost some tests in EID re-arch--bring back

ERRORS
- allow a ValStat to hold a list of Status codes, to capture the full stack (err can wrap an err(stat) return val) or is that too implementation specific? maybe better to have a location embedded within the status byte (or just more granular codes)
- make client error handling use status enum too. the standard is zero string-based errors
- (make a stringifier for status enum for console logs maybe)
- prepend status byte to each API response to wire server errors through to client?
- return ValStats from entdb queries

TESTS
- test import/export at client level
- test HTTP client and server together
- test protocol client against binary test vector responses. make them thorough enough and can generate clients in other lanuages via LLM. can provide mock data in JSON (users, bags, ...)
- document tests, refactor, and ensure each serves a purpose
- load test and benchmark everything with 1mm synthesized operations (per-persona)

PERF
- stream data uploads from client (wire encoder to stream writer somehow)
- stream response downloads in client (wire Decoder to stream reader)
- check whether the indirection in encodeStruct causes a perf hit
- make a noble-based ICrypto implementation and benchmark against libsodium
