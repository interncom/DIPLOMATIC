import * as sodium from "https://raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";
import { encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";

export function serialize(data: unknown): Uint8Array {
  return encode(data);
}

export function encrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const { state } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key) as { state: unknown };
  const enc = sodium.crypto_secretstream_xchacha20poly1305_push(
    state,
    data,
    null,
    sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
  ) as Uint8Array;
  return enc;
}

export function deriveEncryptionKey(seed: Uint8Array): Uint8Array {
  const derivationIndex = 0;
  const encKey = sodium.crypto_kdf_derive_from_key(
    sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    derivationIndex,
    "encKey",
    seed,
  ) as Uint8Array;
  return encKey;
}
