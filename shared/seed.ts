// Master seed and sealed-master brands (identity root material).

import { Status } from "./consts.ts";
import { err, ok, type ValStat } from "./valstat.ts";

const masterSeedSymbol = Symbol("MasterSeed");
const sealedMasterKeySymbol = Symbol("SealedMasterKey");

/** Master seed length in bytes (Ed25519 seed / PRF material). */
export const MASTER_SEED_LEN = 32;

/**
 * AEAD-sealed master (libsodium secretbox combined layout):
 * 24-byte nonce + 32-byte ciphertext + 16-byte MAC.
 */
export const SEALED_MASTER_KEY_LEN = 24 + MASTER_SEED_LEN + 16; // 72

export type MasterSeed = Uint8Array & { readonly [masterSeedSymbol]: true };

/**
 * Master seed sealed under KDF(PRF) (nonce‖ciphertext‖tag).
 * Useless without the PRF output that derives the wrap key.
 */
export type SealedMasterKey = Uint8Array & {
  readonly [sealedMasterKeySymbol]: true;
};

/** Brand `bytes` as {@link MasterSeed} only if length is {@link MASTER_SEED_LEN}. */
export function asMasterSeed(bytes: Uint8Array): ValStat<MasterSeed> {
  if (bytes.byteLength !== MASTER_SEED_LEN) return err(Status.InvalidParam);
  return ok(bytes as MasterSeed);
}

/** Brand `bytes` as {@link SealedMasterKey} only if length is {@link SEALED_MASTER_KEY_LEN}. */
export function asSealedMasterKey(
  bytes: Uint8Array,
): ValStat<SealedMasterKey> {
  if (bytes.byteLength !== SEALED_MASTER_KEY_LEN) {
    return err(Status.InvalidParam);
  }
  return ok(bytes as SealedMasterKey);
}
