// DHKE pair helpers and the enrollee session (PairRequest).
// sealPair returns the pair KEK and enroller pub. Enclave encrypts the
// seed‖hosts wire. PairRequest.finish feeds the decrypted wire back
// through fromSeedHosts.

import { concat } from "../binary.ts";
import type { BundleHost } from "../codecs/bundleHost.ts";
import { Status } from "../consts.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { deriveKey, type PDK, Purpose } from "./derivation.ts";
import type { Enclave } from "./enclave.ts";
import {
  decryptXSalsa20Poly1305Combined,
  genX25519,
  x25519Shared,
} from "./noble.ts";
import type { X25519Sk } from "./x25519.ts";

export const X25519_PUB_LEN = 32;
/** respPub (32) ‖ XSalsa nonce (24) ‖ tag (16); plaintext follows in the ct. */
export const DHKE_RESP_MIN = X25519_PUB_LEN + 24 + 16;

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

// Derives the pairing AEAD key from ECDH and both sides' public keys.
export async function pairKey(
  sk: X25519Sk, // local X25519 priv
  peer: Uint8Array, // ECDH peer pub (enroller: dhkeReq; enrollee: respPub)
  reqPub: Uint8Array, // enrollee pub, bound into KDF
  respPub: Uint8Array, // enroller pub, bound into KDF
): Promise<ValStat<PDK["Pair"]>> {
  if (peer.byteLength !== X25519_PUB_LEN) return err(Status.InvalidParam);
  let shared: Uint8Array;
  try {
    shared = await x25519Shared(sk, peer);
  } catch {
    return err(Status.CryptoError);
  }
  try {
    if (shared.byteLength !== X25519_PUB_LEN || shared.every((b) => b === 0)) {
      return err(Status.InvalidParam);
    }
    const pubs = concat(reqPub, respPub);
    try {
      const [key, st] = await deriveKey({
        parent: shared,
        purpose: Purpose.Pair,
        kdm: pubs,
      });
      if (st !== Status.Success) return err(st);
      return ok(key);
    } finally {
      pubs.fill(0);
    }
  } finally {
    shared.fill(0);
  }
}

// Ephemeral DHKE against an enrollee request. Returns the pair KEK and
// enroller pub. Wipes the ephemeral scalar. Caller wipes `key`.
export async function sealPair(
  dhkeReq: DHKEReq,
): Promise<ValStat<{ key: PDK["Pair"]; pub: Uint8Array }>> {
  let eph: { priv: X25519Sk; pub: Uint8Array } | undefined;
  try {
    eph = await genX25519();
  } catch {
    return err(Status.CryptoError);
  }
  try {
    const [key, kst] = await pairKey(eph.priv, dhkeReq, dhkeReq, eph.pub);
    if (kst !== Status.Success) return err(kst);
    return ok({ key, pub: eph.pub });
  } finally {
    eph.priv.fill(0);
  }
}

const LOCK_SKIP = new Set(["constructor", "prototype", "length", "name"]);

// Freeze every public fn slot on obj so it cannot be replaced after load.
function lockAll(obj: object): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (LOCK_SKIP.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined || typeof desc.value !== "function") continue;
    Object.defineProperty(obj, key, {
      value: desc.value,
      writable: false,
      configurable: false,
    });
  }
}

// Enrollee pairing session. Obtain via Enclave.pairRequest.
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
      const pair = await genX25519();
      priv = pair.priv;
      const [dhkeReq, qst] = asDHKEReq(pair.pub);
      if (qst !== Status.Success) return err(qst);
      const req = new PairRequest(priv, dhkeReq);
      priv = undefined;
      return ok(req);
    } catch {
      return err(Status.CryptoError);
    } finally {
      priv?.fill(0);
    }
  }

  // Drops the ephemeral scalar. Call if the user abandons pairing.
  wipe(): void {
    this.#priv.fill(0);
  }

  // Copy of the enrollee X25519 public key to send to the enroller.
  // Branding the copy checks the length. On failure the private field stays put.
  dhkeReq(): ValStat<DHKEReq> {
    const copy = this.#dhkeReq.slice();
    const [branded, st] = asDHKEReq(copy);
    if (st !== Status.Success) return err(st);
    return ok(branded);
  }

  // Decrypts the enroller's DHKE response into a new Enclave + hosts.
  // Then call sealWithPasskey for a durable binding.
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
    let plain: Uint8Array | undefined;
    try {
      try {
        plain = await decryptXSalsa20Poly1305Combined(body, key);
      } catch {
        return err(Status.DecryptionError);
      }
      const { fromSeedHosts } = await import("./enclave.ts");
      const out = fromSeedHosts(plain);
      if (out[1] === Status.Success) this.wipe();
      return out;
    } finally {
      key.fill(0);
      plain?.fill(0);
    }
  }
}

lockAll(PairRequest);
lockAll(PairRequest.prototype);
