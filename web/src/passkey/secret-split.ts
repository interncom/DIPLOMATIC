// PRF-held seal of master seed for IDB / pair packages (AEAD, not XOR).
// Sealed blob is useless without passkey UV that yields PRF.

import { Status } from "../shared/consts";
import type { ICrypto } from "../shared/types";
import {
  asMasterSeed,
  asSealedMasterKey,
  type MasterSeed,
  type SealedMasterKey,
} from "../shared/seed";
import { err, ok, type ValStat } from "../shared/valstat";
import { concat } from "../shared/binary";

const SEAL_DOMAIN = new TextEncoder().encode("diplomatic.wrap.v1");

/** AEAD key length derived from PRF (blake3 truncate). */
export const SEAL_KEY_LEN = 32;

/** Minimum PRF input length accepted by {@link sealKeyFromPrf}. */
export const SEAL_PRF_MIN_LEN = 16;

/** Derive {@link SEAL_KEY_LEN}-byte seal key from PRF output (domain-separated). */
export async function sealKeyFromPrf(
  crypto: ICrypto,
  prf: Uint8Array,
): Promise<ValStat<Uint8Array>> {
  if (prf.byteLength < SEAL_PRF_MIN_LEN) return err(Status.InvalidParam);
  const hash = await crypto.blake3(concat(prf, SEAL_DOMAIN));
  return ok(hash.slice(0, SEAL_KEY_LEN));
}

/**
 * AEAD-seal master seed under KDF(PRF).
 * Returns {@link SealedMasterKey} (nonce‖ciphertext‖tag).
 */
export async function sealMaster(
  crypto: ICrypto,
  seed: MasterSeed,
  prf: Uint8Array,
): Promise<ValStat<SealedMasterKey>> {
  const [, sst] = asMasterSeed(seed);
  if (sst !== Status.Success) return err(sst);
  const [key, kst] = await sealKeyFromPrf(crypto, prf);
  if (kst !== Status.Success || key === undefined) return err(kst);
  try {
    const sealed = await crypto.encryptXSalsa20Poly1305Combined(seed, key);
    return asSealedMasterKey(sealed);
  } catch {
    return err(Status.InternalError);
  }
}

/** Unseal master with PRF-derived key. */
export async function unsealMaster(
  crypto: ICrypto,
  sealed: SealedMasterKey,
  prf: Uint8Array,
): Promise<ValStat<MasterSeed>> {
  const [, sst] = asSealedMasterKey(sealed);
  if (sst !== Status.Success) return err(sst);
  const [key, kst] = await sealKeyFromPrf(crypto, prf);
  if (kst !== Status.Success || key === undefined) return err(kst);
  try {
    const plain = await crypto.decryptXSalsa20Poly1305Combined(sealed, key);
    return asMasterSeed(plain);
  } catch {
    return err(Status.DecryptionError);
  }
}
