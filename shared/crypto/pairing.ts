// Enrollee half of DHKE pair. Ephemeral X25519 priv never leaves this module.

import { concat } from "../binary.ts";
import { Decoder } from "../codec.ts";
import { pairPackagePlainCodec } from "../codecs/pairPackage.ts";
import type { BundleHost } from "../codecs/bundleHost.ts";
import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { Enclave } from "./enclave.ts";
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

// Derives the pairing AEAD key from ECDH and both sides' publics.
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

// Enrollee pairing session: holds ephemeral X25519 priv until finish.
export class PairRequest {
  #priv: X25519Sk;
  #dhkeReq: DHKEReq;

  private constructor(priv: X25519Sk, dhkeReq: DHKEReq) {
    this.#priv = priv;
    this.#dhkeReq = dhkeReq;
  }

  // Starts an enrollee pairing session. Carry dhkeReq to the enroller.
  static async create(): Promise<ValStat<PairRequest>> {
    let priv: X25519Sk | undefined;
    try {
      const pair = await noble.genX25519();
      priv = pair.priv;
      const [dhkeReq, qst] = asDHKEReq(pair.pub);
      if (qst !== Status.Success || dhkeReq === undefined) {
        return err(qst);
      }
      const req = new PairRequest(priv, dhkeReq);
      priv = undefined;
      return ok(req);
    } catch {
      return err(Status.CryptoError);
    } finally {
      priv?.fill(0);
    }
  }

  // Returns a copy of the enrollee X25519 pub to send as the DHKE request.
  get dhkeReq(): DHKEReq {
    const [q, st] = asDHKEReq(this.#dhkeReq.slice());
    if (q === undefined) throw new Error(`dhkeReq ${st}`);
    return q;
  }

  // Decrypts the enroller's DHKE response into a new Enclave + hosts.
  // Then call sealWithPasskey for durable wrap.
  async finish(
    dhkeResp: DHKEResp,
  ): Promise<ValStat<{ enclave: Enclave; hosts: BundleHost[] }>> {
    const respPub = dhkeResp.subarray(0, X25519_PUB_LEN);
    const body = dhkeResp.subarray(X25519_PUB_LEN);
    const [key, kst] = await pairKey(
      this.#priv,
      respPub,
      this.#dhkeReq,
      respPub,
    );
    if (kst !== Status.Success) return err(kst);
    if (key === undefined) return err(Status.InternalError);
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await noble.decryptXSalsa20Poly1305Combined(body, key);
      } catch {
        return err(Status.DecryptionError);
      }
      const pdec = new Decoder(plain);
      const [inner, is] = pdec.readStruct(pairPackagePlainCodec);
      if (is !== Status.Success) return err(is);
      if (inner === undefined) return err(Status.InvalidMessage);
      try {
        const [enclave, ens] = Enclave.fromBytes(inner.masterSeed);
        if (ens !== Status.Success) return err(ens);
        if (enclave === undefined) return err(Status.InternalError);
        this.#priv.fill(0);
        return ok({
          enclave,
          hosts: inner.hosts.map((h) => ({ ...h })),
        });
      } finally {
        inner.masterSeed.fill(0);
      }
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }
}
