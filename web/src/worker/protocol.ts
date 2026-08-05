// Message protocol between the main thread and the DIPLOMATIC sync worker.
// Commands are request/reply (id). Events are unsolicited (xferState, dirty, …).

import type { Status } from "../shared/consts";
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
  | { id: number; op: "rebuild"; checkHost?: boolean }
  | { id: number; op: "msgcheck" }
  | { id: number; op: "wipe" }
  | { id: number; op: "import"; bytes: Uint8Array }
  | { id: number; op: "export" }
  | { id: number; op: "getClientState" }
  | { id: number; op: "getXferState" };

export type WorkerReply =
  | { kind: "reply"; id: number; ok: true; result?: unknown }
  | { kind: "reply"; id: number; ok: false; status: Status };

export type WorkerEvent =
  | { kind: "ready" }
  /** Worker init failed (e.g. IDB open); main should fail handshake, not hang. */
  | { kind: "initError"; message: string }
  | { kind: "clientState"; state: IDiplomaticClientState }
  /** Queues + sync phase progress (see IDiplomaticClientXferState.progress). */
  | { kind: "xferState"; state: IDiplomaticClientXferState }
  /**
   * Application state (e.g. EntDB) changed for these eids.
   * Main cache pulls only those rows from shared IDB, then notifies by type.
   */
  | { kind: "dirty"; eids: Uint8Array[] }
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
    p === "peek" || p === "pull" || p === "open" || p === "exec" ||
    p === "push" || p === "import" || p === "idle" ||
    // legacy phase name
    p === "apply"
  ) {
    return p === "apply" ? "exec" : p;
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
