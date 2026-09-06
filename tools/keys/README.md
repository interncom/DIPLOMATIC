# keys

CLI key management for DIPLOMATIC (future `diplokey <cmd> LABEL`).

Each **label** is one master (one app or account). Bindings live in
`~/.diplomatic/<LABEL>`: a JSON keyring (`salt` + `entries` by `credId`)
so one label can have several YubiKeys. Different labels do not share a
master.

| Command | Role |
| --- | --- |
| `gen.ts LABEL [--non-resident]` | New master (musec + `fromRandom`), first hmac-secret bind |
| `bind.ts LABEL [--non-resident]` | Unlock, add another YubiKey to that label |
| `pair.ts request LABEL [--non-resident]` | Enrollee: print `DHKEReq`, read `DHKEResp`, bind YubiKey |
| `pair.ts accept LABEL [DHKEREQ_HEX]` | Enroller: unlock, print `DHKEResp` |
| `hexdump.ts LABEL` | Unlock, print 8×8 hex master on the TTY (paper) |
| `hexload.ts LABEL [--non-resident]` | Read 8×8 hex from the TTY, bind first YubiKey |

Requires [fido2-tools](https://developers.yubico.com/libfido2/). Optional
`DIP_FIDO_DEV`. CLI PRF salt is raw hmac-secret, not the browser SHA-256
`"WebAuthn PRF"` map.

```
bun run tools/keys/gen.ts LIFE
bun run tools/keys/gen.ts LIFE --non-resident
bun run tools/keys/bind.ts LIFE
bun run tools/keys/pair.ts accept LIFE
bun run tools/keys/pair.ts accept LIFE 0123…cdef
bun run tools/keys/pair.ts request LIFE
bun run tools/keys/hexdump.ts LIFE
bun run tools/keys/hexload.ts LIFE
bun run tools/keys/hexload.ts LIFE --non-resident
```

Default is a discoverable cred (`fido2-cred -r`): Yubico Authenticator
shows rp `diplomatic` / user `LABEL`, one RK slot. `--non-resident`
skips the slot. `gen` / `pair request` refuse if `~/.diplomatic/LABEL`
exists. `accept`: paste enrollee `DHKEReq`, paste printed resp into the
web app. `request`: paste printed `DHKEReq` into the existing device,
paste its `DHKEResp` back, then bind the plugged YubiKey. `hexdump`: 8 lines of `n] xxxx xxxx` plus a `#` check, one line per Enter
(previous line erased),
on the controlling TTY only (not stdout). `hexload`: type the hex lines
back (whitespace ignored), prints the fingerprint to compare to `#`,
bind a YubiKey; refuses if `~/.diplomatic/LABEL` exists.
