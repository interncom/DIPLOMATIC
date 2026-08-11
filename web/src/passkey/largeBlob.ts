// WebAuthn largeBlob: re-export shared I/O + object API for apps.
// Opaque bytes only — seed persist/load is Enclave.persistToLargeBlob / fromLargeBlob.

import { Status } from "../shared/consts";
import {
  largeBlobCapable,
  largeBlobCreateCred,
  largeBlobRead,
  largeBlobWrite,
  type LargeBlobCreateOpts,
  type LargeBlobRp,
} from "../shared/webauthn/largeBlob";
import { err, ok, type ValStat } from "../shared/valstat";

export type { LargeBlobCreateOpts, LargeBlobRp };

/**
 * WebAuthn largeBlob byte I/O for non-seed opaque data.
 * For seed/identity use {@link Enclave} largeBlob methods only.
 */
export const LargeBlob = {
  capable(): Promise<boolean> {
    return largeBlobCapable();
  },

  async createCred(
    opts?: LargeBlobCreateOpts,
  ): Promise<ValStat<Uint8Array>> {
    return largeBlobCreateCred(opts);
  },

  /**
   * Write arbitrary opaque bytes (UV). Do not pass unencrypted seed from app code.
   */
  async write(
    credId: Uint8Array,
    data: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<Status> {
    return largeBlobWrite(credId, data, opts);
  },

  async read(
    credId: Uint8Array,
    opts?: LargeBlobRp,
  ): Promise<ValStat<Uint8Array>> {
    const [out, st] = await largeBlobRead(credId, opts);
    if (st !== Status.Success || out === undefined) return err(st);
    return ok(out.blob);
  },
} as const;
