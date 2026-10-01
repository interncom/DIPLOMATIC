// IAccountStore backed by WebAuthn largeBlob (OS-held passkey storage).
// Seed encode/decode/UV write-read is owned by Enclave — never handled here.
// One largeBlob credential holds one master, so each account label has its own.

import { Enclave } from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import { err, ok, type ValStat } from "../shared/valstat";
import { accountLabel } from "../stores/label";
import type { IAccountStore, SetSeedOpts } from "../types";
import type { LargeBlobRp } from "../shared/webauthn/largeBlob";

export type PasskeySeedStoreOpts = LargeBlobRp & {
  credId?: Uint8Array;
  /** Account `credId` belongs to. Omitted is the default account, "". */
  label?: string;
};

type Slot = {
  enclave?: Enclave;
  credId?: Uint8Array;
};

/**
 * IAccountStore backed by largeBlob. Session secret is always {@link Enclave}.
 * Each account label has its own credential. Omitted label is "".
 * Persist uses {@link Enclave.persistToLargeBlob} / {@link Enclave.fromLargeBlob}.
 */
export class PasskeySeedStore implements IAccountStore {
  #slots = new Map<string, Slot>();
  /** Account {@link load} and {@link credId} refer to. */
  #label?: string;
  #rpId: string | undefined;
  #rpName: string | undefined;

  constructor(opts: PasskeySeedStoreOpts) {
    this.#rpId = opts.rpId;
    this.#rpName = opts.rpName;
    if (opts.credId === undefined) return;
    const [label, lst] = accountLabel(opts.label);
    if (lst !== Status.Success || label === undefined) return;
    this.#slots.set(label, { credId: opts.credId.slice() });
    this.#label = label;
  }

  /** Credential id of the selected account. */
  get credId(): Uint8Array | undefined {
    const id = this.#slot(this.#label)?.credId;
    return id === undefined ? undefined : id.slice();
  }

  // Sets the credential id for `label` (omitted: the selected account, else "").
  setCredId(credId: Uint8Array | undefined, label?: string): void {
    const [name, lst] = accountLabel(label ?? this.#label);
    if (lst !== Status.Success || name === undefined) return;
    const slot = this.#slots.get(name) ?? {};
    slot.credId = credId === undefined ? undefined : credId.slice();
    this.#put(name, slot);
    this.#label = name;
  }

  async save(
    enclave: Enclave,
    opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    const [label, lst] = accountLabel(opts?.label);
    if (lst !== Status.Success || label === undefined) {
      return err(Status.InvalidParam);
    }
    const slot = this.#slots.get(label) ?? {};
    if (opts?.persist !== true) {
      slot.enclave = enclave;
      this.#put(label, slot);
      this.#label = label;
      return ok(enclave);
    }
    const [id, st] = await enclave.persistToLargeBlob([], {
      rpId: this.#rpId,
      rpName: this.#rpName,
      credId: slot.credId,
    });
    if (st !== Status.Success) return err(st);
    if (id === undefined) return err(Status.WebAuthnError);
    slot.credId = id;
    slot.enclave = enclave;
    this.#put(label, slot);
    this.#label = label;
    return ok(enclave);
  }

  async load(): Promise<Enclave | void> {
    return this.#slot(this.#label)?.enclave;
  }

  // UV-reads the account's largeBlob. Omitted label is the selected account.
  async unlock(opts?: { label?: string }): Promise<ValStat<Enclave>> {
    let label: string;
    if (opts?.label === undefined && this.#label !== undefined) {
      label = this.#label;
    } else {
      const [name, lst] = accountLabel(opts?.label);
      if (lst !== Status.Success || name === undefined) {
        return err(Status.InvalidParam);
      }
      label = name;
    }
    const slot = this.#slots.get(label) ?? {};
    const id = slot.credId;
    if (id === undefined) return err(Status.MissingSeed);
    const [out, st] = await Enclave.fromLargeBlob({
      rpId: this.#rpId,
      rpName: this.#rpName,
      credId: id,
    });
    if (st !== Status.Success) return err(st);
    if (out === undefined) return err(Status.MissingSeed);
    slot.credId = out.credId;
    slot.enclave = out.enclave;
    this.#put(label, slot);
    this.#label = label;
    return ok(out.enclave);
  }

  async wipe(): Promise<void> {
    for (const slot of this.#slots.values()) {
      const id = slot.credId;
      if (id === undefined) continue;
      const st = await Enclave.clearLargeBlob(id, { rpId: this.#rpId });
      if (st !== Status.Success) {
        return Promise.reject(new Error(`clearLargeBlob status ${st}`));
      }
    }
    this.#slots.clear();
    this.#label = undefined;
  }

  #slot(label: string | undefined): Slot | undefined {
    if (label === undefined) return undefined;
    return this.#slots.get(label);
  }

  // Drops a slot that holds neither an enclave nor a credential.
  #put(label: string, slot: Slot): void {
    if (slot.enclave === undefined && slot.credId === undefined) {
      this.#slots.delete(label);
      return;
    }
    this.#slots.set(label, slot);
  }
}
