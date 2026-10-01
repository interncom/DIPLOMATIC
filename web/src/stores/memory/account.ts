import { Status } from "../../shared/consts";
import type { Enclave } from "../../shared/crypto/enclave";
import type { ICrypto } from "../../shared/types";
import { err, ok, type ValStat } from "../../shared/valstat";
import type { IAccountStore, SetSeedOpts } from "../../types";
import { cloneKeyTag, type KeyTag, keyTagMatches, makeKeyTag } from "../keyTag";
import { accountLabel } from "../label";

type Slot = { tag?: KeyTag };

/** Account list in memory. One slot per label. The client holds the open account. */
export class MemoryAccountStore implements IAccountStore {
  #crypto: ICrypto;
  #slots = new Map<string, Slot>();

  constructor(crypto: ICrypto) {
    this.#crypto = crypto;
  }

  // Records the key tag for `opts.label`. Does not select an account.
  async save(
    enclave: Enclave,
    opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    const [label, lst] = accountLabel(opts?.label);
    if (lst !== Status.Success || label === undefined) {
      return err(Status.InvalidParam);
    }
    const slot = this.#slots.get(label) ?? {};
    if (slot.tag !== undefined) {
      const hit = await keyTagMatches(this.#crypto, enclave, slot.tag);
      if (!hit.ok) return err(Status.HashMismatch);
      if (hit.next !== undefined) slot.tag = hit.next;
    } else {
      const [tag, tst] = await makeKeyTag(this.#crypto, enclave);
      if (tst !== Status.Success) return err(tst);
      slot.tag = tag;
    }
    this.#slots.set(label, slot);
    return ok(enclave);
  }

  async wipe() {
    this.#slots.clear();
  }

  /** Test helper: snapshot of one account's key tag. Omitted label is "". */
  peekKeyTag(label = ""): KeyTag | undefined {
    const tag = this.#slots.get(label)?.tag;
    return tag === undefined ? undefined : cloneKeyTag(tag);
  }
}
