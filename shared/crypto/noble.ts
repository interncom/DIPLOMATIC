import { randomBytes } from "@noble/ciphers/webcrypto";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa";
import { blake3 } from "@noble/hashes/blake3";
import { b64urltob, btoh, bytesEqual } from "../binary.ts";
import { Status } from "../consts.ts";
import { asX25519Sk, x25519Pub, type X25519Sk } from "./x25519.ts";
import type {
  DerivationSeed,
  Hash,
  ICrypto,
  KeyPair,
  PrivateKey,
  PublicKey,
} from "../types.ts";

/**
 * PKCS#8 wrapper for a 32-byte Ed25519 seed (RFC 8410).
 * 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20 || seed
 */
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
]);

function ed25519Pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  out.set(ED25519_PKCS8_PREFIX);
  out.set(seed.subarray(0, 32), ED25519_PKCS8_PREFIX.length);
  return out;
}

/**
 * PKCS#8 wrapper for a 32-byte X25519 scalar (RFC 8410).
 * Same as Ed25519 except OID 1.3.101.110 (2b 65 6e).
 */
const X25519_PKCS8_PREFIX = new Uint8Array([
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x6e,
  0x04,
  0x22,
  0x04,
  0x20,
]);

// Wraps an X25519 scalar as PKCS#8 so WebCrypto can importKey (not generateKey).
function x25519Pkcs8FromSk(sk: X25519Sk): Uint8Array {
  const out = new Uint8Array(X25519_PKCS8_PREFIX.length + 32);
  out.set(X25519_PKCS8_PREFIX);
  out.set(sk.subarray(0, 32), X25519_PKCS8_PREFIX.length);
  return out;
}

function toBytes(message: Uint8Array | string): Uint8Array {
  return typeof message === "string"
    ? new TextEncoder().encode(message)
    : message;
}

/** Copy into a fresh ArrayBuffer so SubtleCrypto accepts BufferSource. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

/**
 * ICrypto: noble for XSalsa20 + blake3; WebCrypto Ed25519 + X25519
 * (our scalar; RFC 7748 check before trusting pub/DH).
 */
export class NobleCrypto implements ICrypto {
  private verifyKeys = new Map<string, CryptoKey>();

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
    // Extractable CryptoKey only to read JWK x. Never cache it — that was a
    // process-wide copy of the signing key, often keyed by hex(seed).
    const pkcs8 = ed25519Pkcs8FromSeed(seed);
    const pkcs8Ab = toArrayBuffer(pkcs8);
    let jwk: JsonWebKey;
    try {
      const priv = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        pkcs8Ab,
        { name: "Ed25519" },
        true,
        ["sign"],
      );
      jwk = await globalThis.crypto.subtle.exportKey("jwk", priv);
    } finally {
      // PKCS#8 is seed in a wrapper; wipe both views (toArrayBuffer copies).
      pkcs8.fill(0);
      new Uint8Array(pkcs8Ab).fill(0);
    }
    if (typeof jwk.x !== "string") {
      throw new Error("Ed25519 JWK missing x");
    }
    const x = jwk.x;
    // Drop d so we do not keep a handle to the private scalar (string still GC).
    jwk.d = undefined;
    const pubCryptoKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x },
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    const publicKey = new Uint8Array(
      await globalThis.crypto.subtle.exportKey("raw", pubCryptoKey),
    );
    this.verifyKeys.set(btoh(publicKey), pubCryptoKey);
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

  private async importSignKey(secKey: Uint8Array): Promise<CryptoKey> {
    // Libsodium-format secret key: first 32 bytes are the seed.
    // Non-extractable, not cached: no hex-seed Map and no exportable CryptoKey.
    const seed = secKey.subarray(0, 32);
    const pkcs8 = ed25519Pkcs8FromSeed(seed);
    const pkcs8Ab = toArrayBuffer(pkcs8);
    try {
      return await globalThis.crypto.subtle.importKey(
        "pkcs8",
        pkcs8Ab,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
    } finally {
      pkcs8.fill(0);
      new Uint8Array(pkcs8Ab).fill(0);
    }
  }

  private async importVerifyKey(pubKey: Uint8Array): Promise<CryptoKey> {
    const cacheKey = btoh(pubKey);
    const cached = this.verifyKeys.get(cacheKey);
    if (cached) return cached;
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(pubKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    this.verifyKeys.set(cacheKey, key);
    return key;
  }

  async signEd25519(
    message: Uint8Array | string,
    secKey: Uint8Array,
  ): Promise<Uint8Array> {
    const msg = toBytes(message);
    const key = await this.importSignKey(secKey);
    const sig = await globalThis.crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      toArrayBuffer(msg),
    );
    return new Uint8Array(sig);
  }

  async checkSigEd25519(
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: Uint8Array,
  ): Promise<boolean> {
    const msg = toBytes(message);
    try {
      const key = await this.importVerifyKey(pubKey);
      return await globalThis.crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        toArrayBuffer(sig),
        toArrayBuffer(msg),
      );
    } catch {
      // Invalid key material / unsupported algorithm → not a valid signature.
      return false;
    }
  }

  async blake3(data: Uint8Array): Promise<Hash> {
    return blake3(data) as Hash;
  }

  // Makes an ephemeral X25519 pair from random entropy (not generateKey).
  // Throws if WebCrypto's exported pub disagrees with RFC 7748.
  async genX25519(): Promise<{ priv: X25519Sk; pub: Uint8Array }> {
    const raw = await randomBytes(32);
    raw[0] &= 248;
    raw[31] &= 127;
    raw[31] |= 64;
    const [priv, pst] = asX25519Sk(raw);
    if (pst !== Status.Success || priv === undefined) {
      raw.fill(0);
      throw new Error("X25519 scalar brand failed");
    }
    const want = x25519Pub(priv);
    const pkcs8 = x25519Pkcs8FromSk(priv);
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(pkcs8),
        { name: "X25519" },
        true,
        ["deriveBits"],
      );
      const jwk = await globalThis.crypto.subtle.exportKey("jwk", key);
      if (typeof jwk.x !== "string") {
        throw new Error("X25519 JWK missing x");
      }
      const got = b64urltob(jwk.x);
      jwk.d = undefined;
      if (!bytesEqual(got, want)) {
        throw new Error("X25519 WebCrypto pub != RFC 7748");
      }
      return { priv, pub: want };
    } catch (e) {
      priv.fill(0);
      throw e;
    } finally {
      pkcs8.fill(0);
    }
  }

  // Computes ECDH via WebCrypto deriveBits on our imported scalar.
  // Does not re-check against RFC 7748; pub was checked in genX25519.
  async x25519Shared(
    priv: X25519Sk,
    peerPub: Uint8Array,
  ): Promise<Uint8Array> {
    const pkcs8 = x25519Pkcs8FromSk(priv);
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "pkcs8",
        toArrayBuffer(pkcs8),
        { name: "X25519" },
        false,
        ["deriveBits"],
      );
      const pubKey = await globalThis.crypto.subtle.importKey(
        "raw",
        toArrayBuffer(peerPub),
        { name: "X25519" },
        false,
        [],
      );
      const bits = await globalThis.crypto.subtle.deriveBits(
        { name: "X25519", public: pubKey },
        key,
        256,
      );
      return new Uint8Array(bits);
    } finally {
      pkcs8.fill(0);
    }
  }
}
