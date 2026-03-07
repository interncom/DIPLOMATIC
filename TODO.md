# TODOS

## Later

GENERAL
- Rearchitect Encoder/Decoder so that each primitive has an ICodecPrimitive (like ICodecStruct--maybe same) that holds both encoder and decoder for the primitive in one place
- Fix `// TODO:` in codebase

ARCH
- use codec in EntDB message body for all but application-specific portion, and for that, use an app-provided codec (msgpack) can avoid msgpack dependency

CLIENT
- add a flag to messages in the client store indicating if they've been applied or not. Then syncPull becomes only responsible for downloading and storing (but not applying) messages. In a separate follow-up phase, apply the unapplied messages. Also handle case of failed application in web/src/client.ts apply().
- client override server skewed push rejection by adjusting local timestamp with host offset (no API change necessary)
- determine if it's a risk to allow arbitrary labels upon import (could be used to induce client to derive the keys necessary to hack a targeted host). maybe possible to compute only the pubkey without the privkey? could do that all within Enclave at least and only expose the pubKey
- split React portion into separate package?
- eliminate fileSaver dependency

ENTDB
- split EntDB into separate package?
- use eid index to optimize last()
- unit test with fake indexeddb

ERRORS
- allow a ValStat to hold a list of Status codes, to capture the full stack (err can wrap an err(stat) return val) or is that too implementation specific? maybe better to have a location embedded within the status byte (or just more granular codes)
- (make a stringifier for status enum for console logs maybe)

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
