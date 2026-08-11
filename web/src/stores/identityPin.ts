// Durable local identity pin: binds a device DB to a master seed without
// storing host public keys or any seed material.
//
// Stored: random nonce n + blake3(pinPub).
// pinPub = deriveIdentity(pathFromNonce(n), 0).publicKey
//
// The derive path is the nonce (hex), not a fixed string — so two devices of
// the same user get different pin pubs and digests; an attacker with both
// pin rows cannot correlate them as the same master.

import { btoh } from "../shared/binary";
import type { Enclave } from "../shared/crypto/enclave";
import type { ICrypto } from "../shared/types";

/**
 * Prefix so pin paths never collide with user host labels ("host", …).
 * Full path: `diplomatic.pin/<hex(nonce)>`.
 */
export const ID_PIN_PATH_PREFIX = "diplomatic.pin/";

/** Durable pin row: path-nonce + digest of path-scoped public key. */
export type IdPin = {
  n: Uint8Array;
  h: Uint8Array;
};

/** keyPath for deriveIdentity from the stored nonce. */
export function idPinPath(nonce: Uint8Array): string {
  return ID_PIN_PATH_PREFIX + btoh(nonce);
}

export async function idPinDigest(
  crypto: ICrypto,
  enclave: Enclave,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const idnt = await enclave.deriveIdentity(idPinPath(nonce), 0);
  // Hash so durable meta is never a raw pubkey (host-shaped or otherwise).
  return crypto.blake3(idnt.publicKey);
}

export async function makeIdPin(
  crypto: ICrypto,
  enclave: Enclave,
): Promise<IdPin> {
  const n = await crypto.gen256BitSecureRandomSeed();
  const h = await idPinDigest(crypto, enclave, n);
  return { n, h };
}

export async function idPinMatches(
  crypto: ICrypto,
  enclave: Enclave,
  pin: IdPin,
): Promise<boolean> {
  const h = await idPinDigest(crypto, enclave, pin.n);
  return bytesEq(h, pin.h);
}

export function decodeIdPin(raw: unknown): IdPin | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Partial<IdPin>;
  if (!(o.n instanceof Uint8Array) || !(o.h instanceof Uint8Array)) {
    return undefined;
  }
  if (o.n.byteLength < 1 || o.h.byteLength < 1) return undefined;
  return { n: o.n.slice(), h: o.h.slice() };
}

export function cloneIdPin(pin: IdPin): IdPin {
  return { n: pin.n.slice(), h: pin.h.slice() };
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i] ^ b[i];
  return d === 0;
}
