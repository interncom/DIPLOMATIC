// Message protocol between the main thread and the DIPLOMATIC sync worker.
// Commands are request/reply (id). Events are unsolicited (xferState, dirty, …).

import type { Status } from "../shared/consts";
import type { EntityID, IMessageHead } from "../shared/types";
import type { SyncProgressEvent } from "../progress";
import type {
  IDiplomaticClientState,
  IDiplomaticClientXferState,
} from "../types";

/** Host identity as plain data (URL → string for structured clone). */
export interface SerializedHost {
  handle: string;
  label: string;
  idx: number;
}

export type WorkerCmd =
  | { id: number; op: "ping" }
  | { id: number; op: "setSeed"; seed: Uint8Array }
  | {
    id: number;
    op: "link";
    host: SerializedHost;
    connect?: boolean;
  }
  | { id: number; op: "unlink"; label: string }
  | {
    id: number;
    op: "connect";
    listen?: boolean;
    sync?: boolean;
  }
  | { id: number; op: "disconnect" }
  | { id: number; op: "sync" }
  | { id: number; op: "wipe" }
  | { id: number; op: "insertRaw"; body: Uint8Array }
  | {
    id: number;
    op: "upsertRaw";
    eid: Uint8Array;
    body?: Uint8Array;
    force?: boolean;
  }
  | {
    id: number;
    op: "insert";
    params: {
      type: string;
      body: unknown;
      gid?: string;
      pid?: Uint8Array;
    };
  }
  | {
    id: number;
    op: "upsert";
    params: {
      type: string;
      body: unknown;
      eid?: Uint8Array;
      gid?: string;
      pid?: Uint8Array;
    };
    force?: boolean;
  }
  | { id: number; op: "delete"; eid: Uint8Array }
  | { id: number; op: "import"; bytes: Uint8Array }
  | { id: number; op: "export" }
  | { id: number; op: "getClientState" }
  | { id: number; op: "getXferState" };

export type WorkerReply =
  | { kind: "reply"; id: number; ok: true; result?: unknown }
  | { kind: "reply"; id: number; ok: false; status: Status };

export type WorkerEvent =
  | { kind: "ready" }
  | { kind: "clientState"; state: IDiplomaticClientState }
  /** Queues + sync phase progress (see IDiplomaticClientXferState.progress). */
  | { kind: "xferState"; state: IDiplomaticClientXferState }
  /** Application state (e.g. EntDB) changed for these op types; re-read IDB. */
  | { kind: "dirty"; types: string[] }
  | { kind: "wiped" }
  | WorkerReply;

export function isWorkerEvent(data: unknown): data is WorkerEvent {
  if (!data || typeof data !== "object") {
    return false;
  }
  if (!("kind" in data)) {
    return false;
  }
  return typeof data.kind === "string";
}

export function isWorkerCmd(data: unknown): data is WorkerCmd {
  if (!data || typeof data !== "object") {
    return false;
  }
  if (!("op" in data) || !("id" in data)) {
    return false;
  }
  return typeof data.op === "string" && typeof data.id === "number";
}

/** Narrow helpers for typed replies (avoid casts at call sites). */
export function headFromUnknown(v: unknown): IMessageHead | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  if (!("eid" in v) || !("off" in v) || !("ctr" in v) || !("len" in v)) {
    return undefined;
  }
  const eid = v.eid;
  const off = v.off;
  const ctr = v.ctr;
  const len = v.len;
  if (!(eid instanceof Uint8Array)) {
    return undefined;
  }
  if (
    typeof off !== "number" || typeof ctr !== "number" ||
    typeof len !== "number"
  ) {
    return undefined;
  }
  const head: IMessageHead = {
    eid: eid as EntityID,
    off,
    ctr,
    len,
  };
  if ("hsh" in v && v.hsh instanceof Uint8Array) {
    head.hsh = v.hsh;
  }
  return head;
}

export function statusFromUnknown(v: unknown): Status | undefined {
  if (typeof v !== "number") {
    return undefined;
  }
  return v;
}

export function clientStateFromUnknown(
  v: unknown,
): IDiplomaticClientState | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  if (
    !("hasSeed" in v) || !("hasHost" in v) || !("connected" in v)
  ) {
    return undefined;
  }
  if (
    typeof v.hasSeed !== "boolean" ||
    typeof v.hasHost !== "boolean" ||
    typeof v.connected !== "boolean"
  ) {
    return undefined;
  }
  return {
    hasSeed: v.hasSeed,
    hasHost: v.hasHost,
    connected: v.connected,
  };
}

export function progressFromUnknown(
  v: unknown,
): SyncProgressEvent | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  if (!("phase" in v)) {
    return undefined;
  }
  const phase = phaseFromUnknown(v.phase);
  if (phase === undefined) {
    return undefined;
  }
  const out: SyncProgressEvent = { phase };
  if ("host" in v && typeof v.host === "string") {
    out.host = v.host;
  }
  if ("done" in v && typeof v.done === "number") {
    out.done = v.done;
  }
  if ("total" in v && typeof v.total === "number") {
    out.total = v.total;
  }
  if ("bytesDone" in v && typeof v.bytesDone === "number") {
    out.bytesDone = v.bytesDone;
  }
  if ("bytesTotal" in v && typeof v.bytesTotal === "number") {
    out.bytesTotal = v.bytesTotal;
  }
  return out;
}

function phaseFromUnknown(
  p: unknown,
): SyncProgressEvent["phase"] | undefined {
  if (
    p === "peek" || p === "push" || p === "pull" || p === "apply" ||
    p === "import" || p === "idle"
  ) {
    return p;
  }
  return undefined;
}

export function xferStateFromUnknown(
  v: unknown,
): IDiplomaticClientXferState | undefined {
  if (!v || typeof v !== "object") {
    return undefined;
  }
  if (!("numUploads" in v) || !("numDownloads" in v)) {
    return undefined;
  }
  if (
    typeof v.numUploads !== "number" || typeof v.numDownloads !== "number"
  ) {
    return undefined;
  }
  let progress: SyncProgressEvent = { phase: "idle" };
  if ("progress" in v) {
    const parsed = progressFromUnknown(v.progress);
    if (parsed === undefined) {
      return undefined;
    }
    progress = parsed;
  }
  return {
    numUploads: v.numUploads,
    numDownloads: v.numDownloads,
    progress,
  };
}
