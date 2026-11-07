// Failed bags for one account. Keyed like a download: host, realm, and seq.

import type { IKDM } from "../../shared/codecs/kdm";
import { IErrorPut, IErrorRow, IErrorStore } from "../../types";
import { type DownloadKey, downloadKey } from "../cursor";

export class MemoryErrorStore implements IErrorStore {
  rows = new Map<DownloadKey, IErrorRow>();

  // put records failures. A repeat of the same bag bumps failureCount.
  async put(incoming: Iterable<IErrorPut>) {
    for (const row of incoming) {
      const key = downloadKey(row.host, row.seq, row.realm);
      const prev = this.rows.get(key);
      this.rows.set(key, {
        ...row,
        lastFailedAt: Date.now(),
        failureCount: prev === undefined ? 1 : prev.failureCount + 1,
      });
    }
  }

  async deq(host: string, seqs: Iterable<number>, realm?: IKDM) {
    for (const seq of seqs) {
      this.rows.delete(downloadKey(host, seq, realm));
    }
  }

  async list() {
    const out: IErrorRow[] = [];
    for (const row of this.rows.values()) {
      out.push(row);
    }
    return out;
  }

  async count() {
    return this.rows.size;
  }

  async wipe() {
    this.rows.clear();
  }
}
