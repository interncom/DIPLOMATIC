// Worker-side host: protocol store, crypto, transport, SyncClient, and EntDB writes.
// Main thread reads EntDB from the same IndexedDB; we only post dirty/wiped signals.

import { SyncClient } from "../client";
import crypto from "../crypto";
import { openEntDB } from "../entdb/cached";
import type { IEntDB } from "../entdb/entdb";
import { Clock } from "../shared/clock";
import { Status } from "../shared/consts";
import { Enclave } from "../shared/crypto/enclave";
import { hostHTTPTransport } from "../shared/http";
import { StateManager } from "../state";
import { IDBStore, openBoundStore } from "../stores/idb/store";
import type { SerializedHost, WorkerCmd, WorkerEvent } from "./protocol";

export type PostFn = (msg: WorkerEvent, transfer?: Transferable[]) => void;

function canClose(value: object): value is { close(): void } {
  return "close" in value && typeof value.close === "function";
}

export class WorkerRuntime {
  private client: SyncClient<URL> | undefined;
  private store: IDBStore | undefined;
  private entDB: IEntDB | undefined;
  private boundLabel = "";
  private post: PostFn;
  /** Resolves when bind finishes (success or failure). Cmds wait on this. */
  private whenReady: Promise<void>;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((e: Error) => void) | undefined;

  constructor(post: PostFn) {
    this.post = post;
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  // Opens the account databases named by the main thread. Does not open meta.
  private async bindStores(cmd: {
    label: string;
    data: string;
    ents: string;
  }): Promise<void> {
    if (this.client !== undefined) return;
    try {
      const store = await openBoundStore(crypto, cmd.data);
      const entDB = await openEntDB({ cache: false, name: cmd.ents });
      const state = new StateManager(
        entDB.apply,
        () => entDB.clear(),
        (eids) => {
          if (eids.length < 1) return;
          this.post({
            kind: "dirty",
            eids: eids.map((e) => e.slice()),
          });
        },
      );
      const origClear = state.clear;
      state.clear = async () => {
        const st = await origClear();
        if (st === Status.Success) {
          this.post({ kind: "wiped" });
        }
        return st;
      };
      const client = new SyncClient(
        new Clock(),
        state,
        store,
        hostHTTPTransport,
        crypto,
      );
      this.client = client;
      this.store = store;
      this.entDB = entDB;
      this.boundLabel = cmd.label;
      client.clientState.listen(() => {
        void this.emitClientState();
      });
      client.xferState.listen(() => {
        void this.emitXferState();
      });
      await this.emitXferState();
      this.post({ kind: "ready" });
      this.markReady();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.post({ kind: "initError", message: err.message });
      this.failReady(err);
      throw err;
    }
  }

  private markReady() {
    const done = this.resolveReady;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    if (done) done();
  }

  private failReady(err: Error) {
    const rej = this.rejectReady;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    if (rej) rej(err);
  }

  private requireClient(): SyncClient<URL> {
    if (!this.client) {
      throw new Error("WorkerRuntime not initialized");
    }
    return this.client;
  }

  private async emitClientState() {
    const client = this.client;
    if (!client) return;
    const state = await client.clientState.get();
    this.post({ kind: "clientState", connected: state.connected });
  }

  private async emitXferState() {
    const client = this.client;
    if (!client) return;
    const state = await client.xferState.get();
    this.post({ kind: "xferState", state });
  }

  private hostFromSerialized(h: SerializedHost) {
    return {
      handle: new URL(h.handle),
      label: h.label,
      idx: h.idx,
    };
  }

  async handle(cmd: WorkerCmd): Promise<unknown> {
    // bind opens the databases. Other cmds wait until that finishes.
    if (cmd.op === "bind") {
      await this.bindStores(cmd);
      return undefined;
    }
    await this.whenReady;
    const client = this.requireClient();

    switch (cmd.op) {
      case "ping":
        return "pong";

      case "setSeed": {
        const [enclave, st] = Enclave.fromBytes(cmd.seed);
        cmd.seed.fill(0);
        if (st !== Status.Success) throw new WorkerStatusError(st);
        const opened = await client.adopt(enclave, this.boundLabel);
        if (opened !== Status.Success) throw new WorkerStatusError(opened);
        return undefined;
      }

      case "link": {
        await client.link(
          this.hostFromSerialized(cmd.host),
          cmd.connect ?? true,
        );
        return undefined;
      }

      case "unlink": {
        await client.unlink(cmd.label);
        return undefined;
      }

      case "connect": {
        await client.connect(cmd.listen ?? true, cmd.sync ?? true);
        return undefined;
      }

      case "disconnect": {
        await client.disconnect();
        return undefined;
      }

      case "sync": {
        return await client.sync();
      }

      case "rebuild": {
        return await client.rebuild({
          checkHost: cmd.checkHost ?? true,
        });
      }

      case "reconcile": {
        const [report, st] = await client.reconcile(cmd.hostLabel, {
          pull: cmd.pull,
          push: cmd.push,
          sync: cmd.sync,
        });
        if (st !== Status.Success) {
          throw new WorkerStatusError(st);
        }
        if (!report) {
          throw new WorkerStatusError(Status.InternalError);
        }
        return report;
      }

      case "msgcheck": {
        // Heavy key walk + sort + blake3 off the main thread.
        return await client.msgcheck();
      }

      case "entcheck": {
        const entDB = this.entDB;
        if (!entDB) {
          throw new WorkerStatusError(Status.InternalError);
        }
        const [digest, st] = await entDB.checksum(crypto);
        if (st !== Status.Success) {
          throw new WorkerStatusError(st);
        }
        if (!digest) {
          throw new WorkerStatusError(Status.InternalError);
        }
        return digest;
      }

      case "wipe": {
        await client.wipe({
          msgs: cmd.msgs,
          ents: cmd.ents,
          meta: cmd.meta,
          seed: cmd.seed,
        });
        if (cmd.seed === true) {
          this.store?.close();
          const ent = this.entDB;
          if (ent !== undefined && canClose(ent)) ent.close();
        }
        return undefined;
      }

      case "import": {
        const copy = cmd.bytes.slice();
        const blob = new Blob([copy]);
        const file = new File([blob], "import.dip");
        return await client.import(file);
      }

      case "export": {
        const [bytes, stat] = await client.exportBytes();
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        if (!bytes) {
          throw new WorkerStatusError(Status.InternalError);
        }
        return bytes;
      }

      case "getXferState": {
        return await client.xferState.get();
      }

      default: {
        const _exhaustive: never = cmd;
        void _exhaustive;
        throw new Error("unknown worker command");
      }
    }
  }
}

/** Error carrying a protocol Status for request replies. */
export class WorkerStatusError extends Error {
  constructor(public status: Status) {
    super(`WorkerStatusError: ${Status[status]}`);
    this.name = "WorkerStatusError";
  }
}

export function replyOk(id: number, result?: unknown): WorkerEvent {
  return { kind: "reply", id, ok: true, result };
}

export function replyErr(id: number, status: Status): WorkerEvent {
  return { kind: "reply", id, ok: false, status };
}
