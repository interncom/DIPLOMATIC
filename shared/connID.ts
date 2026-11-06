// Connection ids. The host assigns one per socket so a push can skip that socket.

import { Decoder, Encoder } from "./codec.ts";
import { connIDCodec } from "./codecs/connID.ts";
import { initConnID, maxConnIDBytes, Status } from "./consts.ts";
import { err, ok, ValStat } from "./valstat.ts";

// connIDStatus accepts a connID that encodes in maxConnIDBytes.
// initConnID is a legal push value. A longer encoding is VarLimitExceeded.
export function connIDStatus(n: number): Status {
  return new Encoder().writeVarInt(n, maxConnIDBytes);
}

// nextConnID is the lowest positive id not present in used.
// A closed socket's id can be assigned again.
// None left under the length cap is VarLimitExceeded.
export function nextConnID(used: Iterable<number>): ValStat<number> {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(n)) n++;
  const st = connIDStatus(n);
  if (st !== Status.Success) return err(st);
  return ok(n);
}

// takeConnID reads the body of a connID message.
// The body is one positive varint within maxConnIDBytes. Anything else is initConnID.
export function takeConnID(bytes: Uint8Array): number {
  const [n, st] = new Decoder(bytes).readStruct(connIDCodec);
  if (st !== Status.Success) return initConnID;
  return n;
}

// connIDSkip reports that this listener is the client that pushed.
// A push id of initConnID skips nobody.
export function connIDSkip(listener: number, pushID: number): boolean {
  if (pushID === initConnID) return false;
  return listener === pushID;
}
