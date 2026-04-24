import { randomBytes } from "@noble/ciphers/webcrypto";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa";
import { ed25519 } from "@noble/curves/ed25519";
import { blake3 } from "@noble/hashes/blake3";
import type {
  DerivationSeed,
  Hash,
  ICrypto,
  KeyPair,
  PrivateKey,
  PublicKey,
} from "../types.ts";

export class NobleCrypto implements ICrypto {
  async genRandomBytes(bytes: number): Promise<Uint8Array> {
    return randomBytes(bytes);
  }

  async gen256BitSecureRandomSeed(): Promise<Uint8Array> {
    return randomBytes(32);
  }

  async encryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = randomBytes(24); // XSalsa20 nonce size
    const cipher = xsalsa20poly1305(key, nonce);
    const ciphertext = cipher.encrypt(data);
    // Combine nonce + ciphertext like libsodium crypto_secretbox
    return new Uint8Array([...nonce, ...ciphertext]);
  }

  async decryptXSalsa20Poly1305Combined(
    data: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    const nonce = data.slice(0, 24);
    const ciphertext = data.slice(24);
    const cipher = xsalsa20poly1305(key, nonce);
    return cipher.decrypt(ciphertext);
  }

  async deriveEd25519KeyPair(derivationSeed: DerivationSeed): Promise<KeyPair> {
    const seed = derivationSeed; // 32-byte seed
    const publicKey = ed25519.getPublicKey(seed);
    // Libsodium format: privateKey = seed + publicKey (64 bytes total)
    const privateKey = new Uint8Array(64);
    privateKey.set(seed, 0);
    privateKey.set(publicKey, 32);
    return {
      keyType: "ed25519",
      privateKey: privateKey as PrivateKey,
      publicKey: publicKey as PublicKey,
    };
  }

  async signEd25519(
    message: Uint8Array | string,
    secKey: Uint8Array,
  ): Promise<Uint8Array> {
    const msg = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    // Extract the seed part (first 32 bytes) from libsodium-format private key
    const seed = secKey.slice(0, 32);
    return ed25519.sign(msg, seed);
  }

  async checkSigEd25519(
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const msg = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    return ed25519.verify(sig, msg, pubKey);
  }

  async blake3(data: Uint8Array): Promise<Hash> {
    return blake3(data) as Hash;
  }
}
