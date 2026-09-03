# KEYGEN

KEYGEN collects keystroke timings (musec) and calls `Enclave.fromRandom`
(OS CSPRNG mixed with musec inside the enclave). It then creates a
**non-resident** hmac-secret credential on a YubiKey (`fido2-tools`)
and AEAD-seals the master under that PRF
(`blake3(IKM ‖ diplomatic.bind.v1)`, XSalsa20-Poly1305).

The binding is written to a file (default `~/.diplomatic`, mode 0600).
The master is not printed. The YubiKey stores no seed — only the
hmac-secret key on the credential. Unlock needs UV on that key.

This CLI PRF uses a raw 32-byte hmac-secret salt, not the browser's
SHA-256 `"WebAuthn PRF"` mapping. It will not unseal a web keyring row.

Requires [fido2-tools](https://developers.yubico.com/libfido2/) (`fido2-token`,
`fido2-cred`, `fido2-assert`). Optional `DIP_FIDO_DEV` selects the device
(otherwise the first `fido2-token -L` path).

## Usage

```
bun run keygen.ts [BINDING_FILE]
```

Examples:

```
bun run keygen.ts
bun run keygen.ts ~/.diplomatic
DIP_FIDO_DEV=/dev/hidraw0 bun run keygen.ts
```

Refuses to overwrite an existing file. Two UV ceremonies (create, then
eval). Pair the seed into a web app with `tools/pair`.
