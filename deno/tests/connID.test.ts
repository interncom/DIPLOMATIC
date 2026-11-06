// Connection ids: the host assigns a small varint, and a push skips that socket.

import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import type { IAuthTimestamp } from "../../shared/codecs/authTimestamp.ts";
import { connIDSkip, nextConnID, takeConnID } from "../../shared/connID.ts";
import { connIDFrameCodec } from "../../shared/codecs/connID.ts";
import {
  initConnID,
  maxConnIDBytes,
  NotifType,
  Status,
} from "../../shared/consts.ts";
import { encodeStruct } from "../../shared/codec.ts";
import { notifMsgCodec } from "../../shared/codecs/notifMsg.ts";
import { takeNotif } from "../../shared/sockmsg.ts";
import { ok } from "../../shared/valstat.ts";
import { WebsocketListener } from "../../shared/http/listener.ts";
import { CallbackListener } from "../../shared/lpc/listener.ts";
import { CallbackNotifier } from "../../shared/lpc/pusher.ts";
import { baseMockClock, baseMockCrypto, testPubKey } from "./api/testUtils.ts";

Deno.test("nextConnID is the lowest positive id not in use", () => {
  assertEquals(nextConnID([]), ok(1));
  assertEquals(nextConnID([initConnID, 2]), ok(1));
  assertEquals(nextConnID([1, 2]), ok(3));
  assertEquals(nextConnID([1, 3]), ok(2));
  const used: number[] = [];
  for (let i = 1; i <= 127; i++) used.push(i);
  assertEquals(nextConnID(used), ok(128));
  for (let i = 128; i <= 16383; i++) used.push(i);
  const [full, fst] = nextConnID(used);
  assertEquals(fst, Status.VarLimitExceeded);
  assertEquals(full, undefined);
});

Deno.test("connIDFrameCodec is the assignment and takeConnID reads its body", () => {
  const [frame, st] = encodeStruct(connIDFrameCodec, 1);
  assertEquals(st, Status.Success);
  assertEquals(frame, new Uint8Array([NotifType.ConnID, 1]));
  assertEquals(takeConnID(new Uint8Array([1])), 1);
  assertEquals(takeConnID(new Uint8Array([0x7f])), 127);
  assertEquals(takeConnID(new Uint8Array([0x80, 0x01])), 128);
  assertEquals(takeConnID(new Uint8Array([0])), initConnID);
  assertEquals(takeConnID(new Uint8Array([1, 2])), initConnID);
  assertEquals(takeConnID(new Uint8Array([0x81, 0x80, 0x00])), initConnID);
  const [wide, wst] = encodeStruct(connIDFrameCodec, 16384);
  assertEquals(wst, Status.VarLimitExceeded);
  assertEquals(wide, undefined);
  const [bad, bst] = encodeStruct(connIDFrameCodec, initConnID);
  assertEquals(bst, Status.InvalidParam);
  assertEquals(bad, undefined);
  assertEquals(maxConnIDBytes, 2);
});

Deno.test("takeNotif tells a notif from a connID", () => {
  let id = initConnID;
  const got: Uint8Array[] = [];
  const recv = (b: Uint8Array) => {
    got.push(b);
  };
  const setID = (n: number) => {
    id = n;
  };
  const [note, nst] = encodeStruct(notifMsgCodec, {
    typ: NotifType.Notif,
    body: new Uint8Array([9, 9]),
  });
  assertEquals(nst, Status.Success);
  if (note === undefined) throw new Error("note");
  takeNotif(note, recv, setID);
  assertEquals(id, initConnID);
  assertEquals(got, [new Uint8Array([9, 9])]);
  const [assigned, ast] = encodeStruct(connIDFrameCodec, 4);
  assertEquals(ast, Status.Success);
  if (assigned === undefined) throw new Error("assigned");
  takeNotif(assigned, recv, setID);
  assertEquals(id, 4);
  assertEquals(got.length, 1);
  const [unk, ust] = encodeStruct(notifMsgCodec, {
    typ: 9,
    body: new Uint8Array([1]),
  });
  assertEquals(ust, Status.Success);
  if (unk === undefined) throw new Error("unk");
  takeNotif(unk, recv, setID);
  assertEquals(id, 4);
  assertEquals(got.length, 1);
  const [badID, idSt] = encodeStruct(notifMsgCodec, {
    typ: NotifType.ConnID,
    body: new Uint8Array([0]),
  });
  assertEquals(idSt, Status.Success);
  if (badID === undefined) throw new Error("badID");
  takeNotif(badID, recv, setID);
  assertEquals(id, 4);
  takeNotif(new Uint8Array([0x80, 0x02]), recv, setID);
  assertEquals(id, 4);
  assertEquals(got.length, 1);
  const [too, tst] = encodeStruct(notifMsgCodec, {
    typ: 128,
    body: new Uint8Array([1]),
  });
  assertEquals(tst, Status.VarLimitExceeded);
  assertEquals(too, undefined);
});

Deno.test("connIDSkip ignores a zero push id", () => {
  assertEquals(connIDSkip(1, 1), true);
  assertEquals(connIDSkip(1, 2), false);
  assertEquals(connIDSkip(1, 0), false);
  assertEquals(connIDSkip(0, 0), false);
});

Deno.test("notifier assigns ids and skips the listener that pushed", async () => {
  const notifier = new CallbackNotifier();
  const a = new CallbackListener(notifier, baseMockCrypto, baseMockClock);
  const b = new CallbackListener(notifier, baseMockCrypto, baseMockClock);
  const authTS = {
    pubKey: testPubKey,
    sig: new Uint8Array(64).fill(2),
    timestamp: baseMockClock.now(),
  };
  assertEquals(a.connID(), initConnID);
  let gotA = 0;
  let gotB = 0;
  const stA = await a.connect(authTS, () => {
    gotA += 1;
  });
  const stB = await b.connect(authTS, () => {
    gotB += 1;
  });
  assertEquals(stA, Status.Success);
  assertEquals(stB, Status.Success);
  assertEquals(a.connID(), 1);
  assertEquals(b.connID(), 2);
  const data = new Uint8Array([1]);
  notifier.push(testPubKey, data, a.connID());
  assertEquals(gotA, 0);
  assertEquals(gotB, 1);
  notifier.push(testPubKey, data, 0);
  assertEquals(gotA, 1);
  assertEquals(gotB, 2);
  a.disconnect();
  assertEquals(a.connID(), initConnID);
  const c = new CallbackListener(notifier, baseMockCrypto, baseMockClock);
  const stC = await c.connect(authTS, () => {});
  assertEquals(stC, Status.Success);
  assertEquals(c.connID(), 1);
  assertEquals(b.connID(), 2);
  notifier.push(testPubKey, data, c.connID());
  assertEquals(gotB, 3);
  b.disconnect();
  c.disconnect();
});

Deno.test("websocket listener learns the host connID", async () => {
  const server = Deno.serve({ port: 0 }, (request) => {
    const { socket, response } = Deno.upgradeWebSocket(request);
    socket.onopen = () => {
      const [frame, st] = encodeStruct(connIDFrameCodec, 3);
      if (st !== Status.Success || frame === undefined) return;
      const [note, nst] = encodeStruct(notifMsgCodec, {
        typ: NotifType.Notif,
        body: new Uint8Array([9, 9]),
      });
      if (nst !== Status.Success || note === undefined) return;
      socket.send(frame);
      socket.send(note);
    };
    return response;
  });
  const addr = server.addr;
  if (!("port" in addr)) {
    await server.shutdown();
    throw new Error("expected a tcp port");
  }
  const listener = new WebsocketListener(
    new URL(`http://127.0.0.1:${addr.port}/`),
  );
  let stop = () => {};
  try {
    const authTS: IAuthTimestamp = {
      pubKey: testPubKey,
      sig: new Uint8Array(64),
      timestamp: baseMockClock.now(),
    };
    const got = await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no notif")), 2000);
      stop = () => clearTimeout(timer);
      listener.connect(authTS, (data) => resolve(data));
    });
    assertEquals(listener.connID(), 3);
    assertEquals(got, new Uint8Array([9, 9]));
  } finally {
    stop();
    listener.disconnect();
    await server.shutdown();
  }
});
