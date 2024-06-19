import { encode } from "@msgpack/msgpack";
import * as sodium from "../../cli/vendor/raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";

export function serialize(data: unknown): Uint8Array {
  return encode(data);
}

export function encrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES) as Uint8Array;
  const ciphertext = sodium.crypto_secretbox_easy(data, nonce, key, "uint8array") as Uint8Array;
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);
  return combined;
}

export function decrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = data.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = data.slice(sodium.crypto_secretbox_NONCEBYTES);
  const dec = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key, "uint8array") as Uint8Array;
  return dec;
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
