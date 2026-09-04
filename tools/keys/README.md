# keys

CLI key management for DIPLOMATIC (future `diplokey <cmd> LABEL`).

Each **label** is one master (one app or account). Bindings live in
`~/.diplomatic/<LABEL>`: a JSON keyring (`salt` + `entries` by `credId`)
so one label can have several YubiKeys. Different labels do not share a
master.

| Command | Role |
| --- | --- |
| `gen.ts LABEL` | New master (musec + `fromRandom`), first hmac-secret bind |
| `bind.ts LABEL` | Unlock, add another YubiKey to that label |
| `pair.ts LABEL` | Unlock, DHKE enroller (`DHKEResp` hex on stdout) |

Requires [fido2-tools](https://developers.yubico.com/libfido2/). Optional
`DIP_FIDO_DEV`. CLI PRF salt is raw hmac-secret, not the browser SHA-256
`"WebAuthn PRF"` map.

```
bun run tools/keys/gen.ts LIFE
bun run tools/keys/bind.ts LIFE
bun run tools/keys/pair.ts LIFE
bun run tools/keys/pair.ts LIFE 0123…cdef
```

`gen` refuses if `~/.diplomatic/LABEL` exists. Pair: paste enrollee
`DHKEReq` hex, paste printed resp into the web app, then
`sealWithPasskey` on that origin.
