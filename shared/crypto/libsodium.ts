import type {
  DerivationSeed,
  ICrypto,
  KeyPair,
  PrivateKey,
  PublicKey,
} from "../types.ts";
import { blake3 } from "@noble/hashes/blake3.js";
import * as nobleSecp from "npm:@noble/secp256k1";

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type Libsodium = any;
export class LibsodiumCrypto implements ICrypto {
  sodium: Libsodium;
  constructor(sodium: Libsodium) {
    this.sodium = sodium;
  }

  async gen128BitRandomID(): Promise<Uint8Array> {
    return this.sodium.randombytes_buf(16);
  }

  async gen256BitSecureRandomSeed(): Promise<Uint8Array> {
    return this.sodium.crypto_secretbox_keygen() as Uint8Array;
  }

  async deriveXSalsa20Poly1305Key(
    seed: Uint8Array,
    derivationIndex = 0,
  ): Promise<Uint8Array> {
    const encKey = this.sodium.crypto_kdf_derive_from_key(
      this.sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
      derivationIndex,
      "encKey",
      seed,
    ) as Uint8Array;
    return encKey;
  }

  async encryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = this.sodium.randombytes_buf(
      this.sodium.crypto_secretbox_NONCEBYTES,
    ) as Uint8Array;
    const ciphertext = this.sodium.crypto_secretbox_easy(
      data,
      nonce,
      key,
      "uint8array",
    ) as Uint8Array;
    const combined = new Uint8Array(nonce.length + ciphertext.length);
    combined.set(nonce, 0);
    combined.set(ciphertext, nonce.length);
    return combined;
  }

  async decryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = data.slice(0, this.sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = data.slice(this.sodium.crypto_secretbox_NONCEBYTES);
    const dec = this.sodium.crypto_secretbox_open_easy(
      ciphertext,
      nonce,
      key,
      "uint8array",
    ) as Uint8Array;
    return dec;
  }

  async deriveSchnorrKeyPair(derivationSeed: DerivationSeed): Promise<KeyPair> {
    const priv = new Uint8Array(derivationSeed);
    const pub = nobleSecp.schnorr.getPublicKey(priv);
    return {
      keyType: "private",
      privateKey: priv as unknown as PrivateKey,
      publicKey: pub as unknown as PublicKey,
    };
  }

  async signSchnorr(
    message: Uint8Array | string,
    secKey: PrivateKey,
  ): Promise<Uint8Array> {
    const msg = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    return nobleSecp.schnorr.sign(msg, secKey as Uint8Array);
  }

  async checkSigSchnorr(
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: PublicKey,
  ): Promise<boolean> {
    const msg = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    try {
      return nobleSecp.schnorr.verify(sig, msg, pubKey);
    } catch {
      return false;
    }
  }

  async blake3(data: Uint8Array): Promise<Uint8Array> {
    return blake3(data);
  }

  async sha256Hash(data: Uint8Array): Promise<Uint8Array> {
    const buf = await crypto.subtle.digest("SHA-256", data.slice(0));
    const arr = new Uint8Array(buf);
    return arr;
  }
}
