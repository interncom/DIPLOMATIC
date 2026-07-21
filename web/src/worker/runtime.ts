// Worker-side host: protocol store, crypto, transport, SyncClient, and EntDB writes.
// Main thread reads EntDB from the same IndexedDB; we only post dirty/wiped signals.

import { SyncClient } from "../client";
import crypto from "../crypto";
import { openEntIDB } from "../entdb/idb";
import { Clock } from "../shared/clock";
import { Status } from "../shared/consts";
import { hostHTTPTransport } from "../shared/http";
import { EncodedMessage } from "../shared/message";
import type { EntityID, MasterSeed } from "../shared/types";
import { StateManager } from "../state";
import { openIDBStore } from "../stores/idb/store";
import type { SerializedHost, WorkerCmd, WorkerEvent } from "./protocol";

export type PostFn = (msg: WorkerEvent, transfer?: Transferable[]) => void;

export class WorkerRuntime {
  private client: SyncClient<URL> | undefined;
  private post: PostFn;
  /** Resolves when init finishes (success or failure). Cmds wait on this. */
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

  async init(): Promise<void> {
    try {
      const store = await openIDBStore(crypto);
      const entDB = await openEntIDB();
      // Real EntDB apply in-worker; signal main to re-read shared IDB.
      const state = new StateManager(
        entDB.apply,
        () => entDB.clear(),
        (types) => {
          this.post({ kind: "dirty", types: Array.from(types) });
        },
      );
      // Ensure clear also notifies main (wipe path).
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

      // Progress lives on xferState; one channel for queues + phase ticks.
      client.clientState.listen(() => {
        void this.emitClientState();
      });
      client.xferState.listen(() => {
        void this.emitXferState();
      });

      this.post({ kind: "ready" });
      this.markReady();
      await this.emitClientState();
      await this.emitXferState();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
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
    this.post({ kind: "clientState", state });
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
    // Early cmds (esp. main-thread handshake ping) wait until init finishes.
    // Unsolicited `ready` can be missed if the app constructed the Worker before
    // attaching onmessage; request/response still works.
    await this.whenReady;
    const client = this.requireClient();

    switch (cmd.op) {
      case "ping":
        return "pong";

      case "setSeed": {
        await client.setSeed(toMasterSeed(cmd.seed));
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

      case "wipe": {
        await client.wipe();
        return undefined;
      }

      // Mutate RPCs: unused today. WorkerClient applies insert/upsert/delete on
      // main (shared IDB + fast UI) and only hands network sync to the worker.
      // Kept for a future path: main optimistic cache + async durable write here,
      // with dirty/ack to reconcile UI to EntDB truth.
      case "insertRaw": {
        const [head, stat] = await client.insertRaw(toEncoded(cmd.body));
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        return head;
      }

      case "upsertRaw": {
        const [head, stat] = await client.upsertRaw(
          toEntityID(cmd.eid),
          cmd.body !== undefined ? toEncoded(cmd.body) : undefined,
          cmd.force,
        );
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        return head;
      }

      case "insert": {
        const [head, stat] = await client.insert({
          type: cmd.params.type,
          body: cmd.params.body,
          gid: cmd.params.gid,
          pid: cmd.params.pid !== undefined
            ? toEntityID(cmd.params.pid)
            : undefined,
        });
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        return head;
      }

      case "upsert": {
        const [head, stat] = await client.upsert(
          {
            type: cmd.params.type,
            body: cmd.params.body,
            eid: cmd.params.eid !== undefined
              ? toEntityID(cmd.params.eid)
              : undefined,
            gid: cmd.params.gid,
            pid: cmd.params.pid !== undefined
              ? toEntityID(cmd.params.pid)
              : undefined,
          },
          cmd.force,
        );
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        return head;
      }

      case "delete": {
        const [head, stat] = await client.delete(toEntityID(cmd.eid));
        if (stat !== Status.Success) {
          throw new WorkerStatusError(stat);
        }
        return head;
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

      case "getClientState": {
        return await client.clientState.get();
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

function toMasterSeed(bytes: Uint8Array): MasterSeed {
  if (bytes.length !== 32) {
    throw new WorkerStatusError(Status.InvalidParam);
  }
  return bytes as MasterSeed;
}

function toEntityID(bytes: Uint8Array): EntityID {
  return bytes as EntityID;
}

function toEncoded(bytes: Uint8Array): EncodedMessage {
  return bytes;
}
