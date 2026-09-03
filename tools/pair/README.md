# PAIR

PAIR is the **enroller** half of DIPLOMATIC DHKE pairing. It unlocks a
CLI PRF binding (from KEYGEN) with a YubiKey UV and accepts an enrollee
`DHKEReq` (64 hex chars from the web app). It prints `DHKEResp` hex on
stdout for paste back into the page.

The web app then `finish`es and `sealWithPasskey` for its own origin
binding. The CLI hmac-secret cred is not reused by the browser (`rpId`
`diplomatic`, different salt).

Requires `fido2-tools`. Progress and PIN prompts go to stderr so
`> resp.hex` is safe.

## Usage

On the web app (enrollee): start pair, copy `DHKEReq` hex.

```
bun run pair.ts [BINDING_FILE] [DHKEREQ_HEX]
```

Default binding is `~/.diplomatic`. If the hex is omitted, PAIR reads it
from stdin (prompts when stdin is a TTY).

Examples:

```
bun run pair.ts
bun run pair.ts ~/.diplomatic
bun run pair.ts ~/.diplomatic 0123…cdef
echo 0123…cdef | bun run pair.ts
```

Paste the printed hex into the web app to finish. Take the request from
the enrollee in front of you (unauthenticated ECDH).
