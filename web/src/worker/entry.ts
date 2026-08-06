// DIPLOMATIC sync worker entry. Bundled as a separate module (see pkg/build-web.mjs).
// Runs in a DedicatedWorkerGlobalScope (browser module worker).

import { Status } from "../shared/consts";
import { isWorkerCmd, type WorkerCmd } from "./protocol";
import { replyErr, replyOk, WorkerRuntime, WorkerStatusError } from "./runtime";

const scope = globalThis as unknown as {
  postMessage: (msg: unknown, transfer?: Transferable[]) => void;
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
};

const runtime = new WorkerRuntime((msg, transfer) => {
  if (transfer && transfer.length > 0) {
    scope.postMessage(msg, transfer);
  } else {
    scope.postMessage(msg);
  }
});

scope.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data;
  if (!isWorkerCmd(data)) {
    return;
  }
  void handleCmd(data);
};

async function handleCmd(cmd: WorkerCmd): Promise<void> {
  try {
    const result = await runtime.handle(cmd);
    // Transfer large/binary results (export; msgcheck / entcheck digests).
    if (
      (cmd.op === "export" || cmd.op === "msgcheck" || cmd.op === "entcheck") &&
      result instanceof Uint8Array
    ) {
      const copy = result.slice();
      scope.postMessage(replyOk(cmd.id, copy), [copy.buffer]);
      return;
    }
    // Reconcile report: transfer msgcheck buffer.
    if (
      cmd.op === "reconcile" &&
      result &&
      typeof result === "object" &&
      "msgcheck" in result &&
      result.msgcheck instanceof Uint8Array
    ) {
      const msgcheck = result.msgcheck.slice();
      const report = {
        ...result,
        msgcheck,
      };
      scope.postMessage(replyOk(cmd.id, report), [msgcheck.buffer]);
      return;
    }
    scope.postMessage(replyOk(cmd.id, result));
  } catch (e) {
    if (e instanceof WorkerStatusError) {
      scope.postMessage(replyErr(cmd.id, e.status));
      return;
    }
    console.error("worker command failed", e);
    scope.postMessage(replyErr(cmd.id, Status.InternalError));
  }
}

void runtime.init().catch((e) => {
  console.error("worker init failed", e);
});
