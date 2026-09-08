// DHKE pair helpers. Enrollee session lives on Enclave (pairRequest handle)
// so seed-bearing pair plaintext never exists outside that file.

import { concat } from "../binary.ts";
import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { NobleCrypto } from "./noble.ts";
import type { X25519Sk } from "./x25519.ts";

export const SEAL_PAIR_DOMAIN = new TextEncoder().encode(
  "diplomatic.qrpair.v1",
);
export const X25519_PUB_LEN = 32;
/** respPub (32) ‖ XSalsa nonce (24) ‖ tag (16); plaintext follows in the ct. */
export const DHKE_RESP_MIN = X25519_PUB_LEN + 24 + 16;
const SEAL_KEY_LEN = 32;

const dhkeReqSymbol = Symbol("DHKEReq");
const dhkeRespSymbol = Symbol("DHKEResp");

export type DHKEReq = Uint8Array & { readonly [dhkeReqSymbol]: true };
export type DHKEResp = Uint8Array & { readonly [dhkeRespSymbol]: true };

// Brands a 32-byte enrollee X25519 pub as a DHKE request.
export function asDHKEReq(bytes: Uint8Array): ValStat<DHKEReq> {
  if (bytes.byteLength !== X25519_PUB_LEN) return err(Status.InvalidParam);
  return ok(bytes as DHKEReq);
}

// Brands a DHKE response (respPub ‖ XSalsa combined).
// Rejects if shorter than DHKE_RESP_MIN.
export function asDHKEResp(bytes: Uint8Array): ValStat<DHKEResp> {
  if (bytes.byteLength < DHKE_RESP_MIN) return err(Status.InvalidParam);
  return ok(bytes as DHKEResp);
}

const noble = new NobleCrypto();

// Derives the pairing AEAD key from ECDH and both sides' public keys.
export async function pairKey(
  sk: X25519Sk, // local X25519 priv
  peer: Uint8Array, // ECDH peer pub (enroller: dhkeReq; enrollee: respPub)
  reqPub: Uint8Array, // enrollee pub, bound into KDF
  respPub: Uint8Array, // enroller pub, bound into KDF
): Promise<ValStat<Uint8Array>> {
  let shared: Uint8Array;
  try {
    shared = await noble.x25519Shared(sk, peer);
  } catch {
    return err(Status.CryptoError);
  }
  try {
    if (shared.byteLength !== X25519_PUB_LEN || shared.every((b) => b === 0)) {
      return err(Status.InvalidParam);
    }
    const head = concat(shared, SEAL_PAIR_DOMAIN); // S ‖ domain
    const mix = concat(head, concat(reqPub, respPub));
    try {
      const hash = await noble.blake3(mix);
      return ok(hash.slice(0, SEAL_KEY_LEN));
    } finally {
      head.fill(0);
      mix.fill(0);
    }
  } finally {
    shared.fill(0);
  }
}
