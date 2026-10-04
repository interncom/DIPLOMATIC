import type { IKDM } from "../../shared/codecs/kdm";
import { Status } from "../../shared/consts";
import { nullKDM } from "../../shared/crypto/derivation";
import {
  HostHandle,
  IHostConnectionInfo,
  IHostMetadata,
} from "../../shared/types";
import type { HostSeqsUpdate, IHostRow, IHostStore } from "../../types";
import {
  nextCursor,
  projectCursors,
  type RealmCursor,
  realmKey,
} from "../cursor";

export class MemoryHostStore<Handle extends HostHandle>
  implements IHostStore<Handle> {
  hosts = new Map<string, IHostRow<Handle>>();
  // Cursors for one host, keyed by realm. The host row keeps identity only.
  #cursors = new Map<string, Map<string, RealmCursor>>();

  /**
   * Upsert connection info. Same label + same handle/idx keeps cursors and
   * host meta (safe re-link). Changing handle/idx clears cursors.
   */
  async add(info: IHostConnectionInfo<Handle>) {
    const prev = this.hosts.get(info.label);
    if (
      prev !== undefined &&
      prev.handle === info.handle &&
      (prev.idx ?? 0) === (info.idx ?? 0)
    ) {
      this.hosts.set(info.label, {
        ...info,
        lastSeq: 0,
        clockOffset: prev.clockOffset,
        subscription: prev.subscription,
      });
      return;
    }
    this.#cursors.delete(info.label);
    this.hosts.set(info.label, { ...info, lastSeq: 0 });
  }

  // Cursor only advances. Concurrent peek/push/notif must not regress it.
  async touch(label: string, seq: number, realm?: IKDM) {
    await this.recordSeqs(label, { lastSeq: seq }, realm);
  }

  async recordSeqs(label: string, u: HostSeqsUpdate, realm?: IKDM) {
    if (!this.hosts.has(label)) return;
    const r = realm ?? nullKDM;
    const key = realmKey(r);
    const bucket = this.#cursors.get(label);
    const cur = bucket?.get(key)?.lastSeq ?? 0;
    const next = nextCursor(cur, u);
    if (next === undefined) return;
    const nextBucket = bucket ?? new Map();
    if (bucket === undefined) this.#cursors.set(label, nextBucket);
    nextBucket.set(key, { label: r.label, index: r.index, lastSeq: next });
  }

  async get(label: string) {
    const host = this.hosts.get(label);
    if (host === undefined) return undefined;
    this.#projectRealmCursors(host);
    return host;
  }

  async set(label: string, meta: IHostMetadata) {
    const row = this.hosts.get(label);
    if (!row) {
      return Status.NotFound;
    }
    this.hosts.set(label, { ...row, ...meta });
    return Status.Success;
  }

  async del(label: string) {
    this.hosts.delete(label);
    this.#cursors.delete(label);
  }

  async list() {
    const rows: IHostRow<Handle>[] = [];
    for (const host of this.hosts.values()) {
      this.#projectRealmCursors(host);
      rows.push(host);
    }
    return rows;
  }

  async wipe() {
    this.hosts.clear();
    this.#cursors.clear();
  }

  // Joins this host's cursors onto the row. A missing cursor stays 0.
  #projectRealmCursors(host: IHostRow<Handle>) {
    const bucket = this.#cursors.get(host.label);
    const cursors: RealmCursor[] = [];
    if (bucket !== undefined) {
      for (const c of bucket.values()) cursors.push(c);
    }
    const projected = projectCursors(cursors);
    host.lastSeq = projected.lastSeq;
    if (projected.seqs !== undefined) host.seqs = projected.seqs;
    else delete host.seqs;
  }
}
