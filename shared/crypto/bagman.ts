// Bag encrypt, decrypt, and sign for one identity and one realm. No seed.

import type { IKDM } from "../codecs/kdm.ts";
import { kdmBytes, Status } from "../consts.ts";
import type { DerivationSeed, PublicKey } from "../types.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import { deriveKey, Purpose } from "./derivation.ts";
import type { HostRlm, PDK } from "./derivation.ts";
import {
  decryptXSalsa20Poly1305Combined,
  deriveEd25519KeyPair,
  encryptXSalsa20Poly1305Combined,
  signEd25519,
} from "./noble.ts";

// Brands an Identity PDK, derived from the master seed, as the Ed25519 seed.
function asDerivSeed(child: PDK["Identity"]): DerivationSeed {
  return child as Uint8Array as DerivationSeed;
}

export class BagManager {
  private constructor(
    public readonly publicKey: PublicKey,
    // Identity PDK for this label, derived from the master seed. Not wiped per sign.
    private idnt: PDK["Identity"],
    // Realm key. Cipher parent today; a TWK set replaces it later.
    private realm: PDK["RealmKey"],
    // Host rlm for this pair.
    public readonly rlm: HostRlm,
    // Frozen identity KDM this manager signs as.
    public readonly idKDM: Readonly<IKDM>,
    // Frozen realm KDM this manager seals.
    public readonly realmKDM: Readonly<IKDM>,
  ) {}

  // Initializes a BagManager. Takes ownership of idnt, realm, and rlm.
  // Wipes them if the pubkey fails.
  static async init(
    idnt: PDK["Identity"],
    realm: PDK["RealmKey"],
    rlm: HostRlm,
    idKDM: IKDM,
    realmKDM: IKDM,
  ): Promise<ValStat<BagManager>> {
    try {
      const keys = await deriveEd25519KeyPair(asDerivSeed(idnt));
      const pubKey = keys.publicKey;
      keys.privateKey.fill(0);
      const idk = Object.freeze({ ...idKDM });
      const rlk = Object.freeze({ ...realmKDM });
      const bagman = new BagManager(pubKey, idnt, realm, rlm, idk, rlk);
      return ok(bagman);
    } catch {
      idnt.fill(0);
      realm.fill(0);
      rlm.fill(0);
      return err(Status.CryptoError);
    }
  }

  // Ed25519 signature. The private key is wiped before return.
  async sign(message: Uint8Array | string): Promise<ValStat<Uint8Array>> {
    let keys;
    try {
      keys = await deriveEd25519KeyPair(asDerivSeed(this.idnt));
    } catch {
      return err(Status.CryptoError);
    }
    try {
      return ok(await signEd25519(message, keys.privateKey));
    } catch {
      return err(Status.CryptoError);
    } finally {
      keys.privateKey.fill(0);
    }
  }

  // Per-bag 8-byte KDM from the encoded message head.
  async bagKDM(msgHeadEnc: Uint8Array): Promise<ValStat<Uint8Array>> {
    const [kdmPDK, cst] = await deriveKey({
      parent: this.idnt,
      purpose: Purpose.BagKdm,
      kdm: msgHeadEnc,
    });
    if (cst !== Status.Success) return err(cst);
    try {
      return ok(kdmPDK.slice(0, kdmBytes));
    } finally {
      kdmPDK.fill(0);
    }
  }

  // Encrypts under this realm. `kdm` is the public bag kdm.
  async encrypt(
    kdm: Uint8Array,
    data: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    const [key, st] = await this.#cipher(kdm.slice());
    if (st !== Status.Success) return err(st);
    try {
      return ok(await encryptXSalsa20Poly1305Combined(data, key));
    } catch {
      return err(Status.CryptoError);
    } finally {
      key.fill(0);
    }
  }

  // Decrypts under this realm. `kdm` is the public bag kdm.
  async decrypt(
    kdm: Uint8Array,
    data: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    const [key, st] = await this.#cipher(kdm.slice());
    if (st !== Status.Success) return err(st);
    try {
      return ok(await decryptXSalsa20Poly1305Combined(data, key));
    } catch {
      return err(Status.DecryptionError);
    } finally {
      key.fill(0);
    }
  }

  // Cipher key for one bag. Does not wipe the realm key.
  async #cipher(kdm: Uint8Array): Promise<ValStat<PDK["Cipher"]>> {
    return deriveKey({
      parent: this.realm,
      purpose: Purpose.Cipher,
      kdm,
    });
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

lockAll(BagManager);
lockAll(BagManager.prototype);
