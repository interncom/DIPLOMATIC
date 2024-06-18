import * as sodium from "https://raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";

export interface IKeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface KeyPair {
  keyType: "public" | "private" | "secret";
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateSeed(): Uint8Array {
  return sodium.crypto_secretbox_keygen() as Uint8Array;
}

export function deriveAuthKeyPair(hostID: string, seed: Uint8Array): KeyPair {
  const derivationIndex = 0;
  const keyPairDerivationSeed = sodium.crypto_kdf_derive_from_key(
    sodium.crypto_box_SEEDBYTES,
    derivationIndex,
    hostID,
    seed,
  );
  const keyPair = sodium.crypto_sign_seed_keypair(
    keyPairDerivationSeed,
  ) as KeyPair;
  return keyPair;
}

// Sign the current timestamp. Send that. Server verifies that it is recent enough, and that the signature is valid.
interface IAuthorizationWitness {
  pubKey: Uint8Array;
  timestamp: string;
  sig: Uint8Array;
}

export function generateAuthorizationWitness(
  now: Date,
  keyPair: KeyPair,
): IAuthorizationWitness {
  const timestamp = now.toUTCString();
  const sig = sign(timestamp, keyPair);
  return {
    pubKey: keyPair.publicKey,
    timestamp,
    sig,
  };
}

export function sign(
  message: Uint8Array | string,
  keyPair: IKeyPair,
): Uint8Array {
  const sig = sodium.crypto_sign_detached(
    message,
    keyPair.privateKey,
    "uint8array",
  ) as Uint8Array;
  return sig;
}

export function checkSig(
  sig: Uint8Array,
  message: Uint8Array | string,
  pubKey: Uint8Array,
): boolean {
  // Separate the sig for easier interop with other implementations, e.g. Noble or WebCrypto.
  const valid = sodium.crypto_sign_verify_detached(sig, message, pubKey);
  return valid;
}

export function validateAuthorizationWitness(
  now: Date,
  witness: IAuthorizationWitness,
): boolean {
  const acceptableLagSeconds = 100;
  const tsDate = new Date(witness.timestamp);
  const recentEnough = now.getTime() - tsDate.getTime() <= acceptableLagSeconds;
  if (!recentEnough) {
    return false;
  }
  const verified = sodium.crypto_sign_verify_detached(
    witness.sig,
    witness.timestamp,
    witness.pubKey,
  );
  if (!verified) {
    return false;
  }
  return true;
}
