import { decode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import { checkSig } from "./auth.ts";
import type { CipherOp, ISyncRequest } from "./types.ts";

type UserPubKey = Uint8Array;
type Timestamp = string;
type OpStore = Map<UserPubKey, Map<Timestamp, CipherOp>>;

export interface ISyncResponse {
  ops: CipherOp[];
  syncedAt: Timestamp;
}

export class API {
  private id: string;
  private now: Date;
  users: Set<UserPubKey>;
  ops: OpStore;

  constructor(id: string, now: Date) {
    this.id = id;
    this.users = new Set();
    this.ops = new Map();
    this.now = now;
  }

  getID(): string {
    return this.id;
  }

  getNow(): string {
    return this.now.toUTCString();
  }

  setNow(now: Date) {
    this.now = now;
  }

  postUsers(pubKey: Uint8Array) {
    this.users.add(pubKey);
  }

  postSync(
    reqPack: Uint8Array,
    pubKey: Uint8Array,
    sig: Uint8Array,
  ): ISyncResponse {
    if (!this.users.has(pubKey)) {
      throw "Unauthorized";
    }

    const sigValid = checkSig(sig, reqPack, pubKey);
    if (!sigValid) {
      throw "Invalid signature";
    }

    const req = decode(reqPack) as ISyncRequest;
    // TODO: runtime typecheck it's a valid ISyncRequest.

    const userOps = this.ops.get(pubKey) ?? new Map();

    // Accumulate ops to return.
    const returnOps: CipherOp[] = [];
    for (const [ts, op] of userOps) {
      if (ts > req.begin) {
        returnOps.push(op);
      }
    }

    // Record synced ops.
    for (const op of req.ops) {
      const recordedAt: Timestamp = new Date().toUTCString();
      userOps.set(recordedAt, op);
    }
    this.ops.set(pubKey, userOps);

    return { ops: returnOps, syncedAt: new Date().toUTCString() };
  }
}
