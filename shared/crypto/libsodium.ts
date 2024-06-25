import type { ICrypto, KeyPair } from "../types.ts";

type Libsodium = any;
export class LibsodiumCrypto implements ICrypto {
  sodium: Libsodium;
  constructor(sodium: Libsodium) {
    this.sodium = sodium;
  }

  async gen256BitSecureRandomSeed(): Promise<Uint8Array> {
    return this.sodium.crypto_secretbox_keygen() as Uint8Array;
  }

  async deriveXSalsa20Poly1305Key(seed: Uint8Array): Promise<Uint8Array> {
    const derivationIndex = 0;
    const encKey = this.sodium.crypto_kdf_derive_from_key(
      this.sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
      derivationIndex,
      "encKey",
      seed,
    ) as Uint8Array;
    return encKey;
  }

  async encryptXSalsa20Poly1305Combined(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const nonce = this.sodium.randombytes_buf(this.sodium.crypto_secretbox_NONCEBYTES) as Uint8Array;
    const ciphertext = this.sodium.crypto_secretbox_easy(data, nonce, key, "uint8array") as Uint8Array;
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce, 0);
    combined.set(ciphertext, nonce.length);
    return combined;
  }

  async decryptXSalsa20Poly1305Combined(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
    const nonce = data.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = data.slice(this.sodium.crypto_secretbox_NONCEBYTES);
    const dec = this.sodium.crypto_secretbox_open_easy(ciphertext, nonce, key, "uint8array") as Uint8Array;
    return dec;
  }

  async deriveEd25519KeyPair(seed: Uint8Array, hostID: string, derivationIndex = 0): Promise<KeyPair> {
    const keyPairDerivationSeed = this.sodium.crypto_kdf_derive_from_key(
      this.sodium.crypto_box_SEEDBYTES,
      derivationIndex,
      hostID,
      seed,
    );
    const keyPair = this.sodium.crypto_sign_seed_keypair(
      keyPairDerivationSeed,
    ) as KeyPair;
    return keyPair;
  }

  async signEd25519(
    message: Uint8Array | string,
    secKey: Uint8Array,
  ): Promise<Uint8Array> {
    const sig = this.sodium.crypto_sign_detached(
      message,
      secKey,
      "uint8array",
    ) as Uint8Array;
    return sig;
  }

  async checkSigEd25519(
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    // Separate the sig for easier interop with other implementations, e.g. Noble or WebCrypto.
    const valid = this.sodium.crypto_sign_verify_detached(sig, message, pubKey);
    return valid;
  }
}
