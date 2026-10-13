// In-memory realm counters for one account.

import { Status } from "../../shared/consts";
import {
  advanceRealm,
  decodeRealm,
  type IRealm,
  type IRealmStore,
} from "../realm";

/** Realm counters in memory. One store is one account. */
export class MemoryRealmStore implements IRealmStore {
  #rows = new Map<string, IRealm>();

  async list(): Promise<IRealm[]> {
    const out: IRealm[] = [];
    for (const row of this.#rows.values()) {
      const decoded = decodeRealm(row);
      if (decoded !== undefined) out.push(decoded);
    }
    return out;
  }

  async get(label: string): Promise<IRealm | undefined> {
    return decodeRealm(this.#rows.get(label));
  }

  async put(label: string, index: number): Promise<Status> {
    const [next, st] = advanceRealm(label, await this.get(label), index);
    if (st !== Status.Success) return st;
    this.#rows.set(label, next);
    return Status.Success;
  }

  async wipe() {
    this.#rows.clear();
  }
}
