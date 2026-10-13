// Tests that peek and pull carry the host realm id for the requested realm.

import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { bytesEqual } from "../../shared/binary.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Clock } from "../../shared/clock.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { authTimestampCodec } from "../../shared/codecs/authTimestamp.ts";
import type { IKDM } from "../../shared/codecs/kdm.ts";
import { peekItemHeadCodec } from "../../shared/codecs/peekItemHead.ts";
import { Status } from "../../shared/consts.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { peekCursorCodec } from "../../shared/api/peek.ts";
import { pullReqCodec } from "../../shared/api/pull.ts";
import { genInsert } from "../../shared/message.ts";
import { decryptPeekItem } from "../../shared/sync.ts";
import type {
  IBag,
  IHostConnectionInfo,
  ITransport,
} from "../../shared/types.ts";
import { err } from "../../shared/valstat.ts";
import libsodiumCrypto from "../src/crypto.ts";

const inbox: IKDM = { label: "inbox", index: 1 };

// Records the encoded request and does not answer.
function transport(sent: Uint8Array[]): ITransport {
  return {
    call(_name, enc) {
      sent.push(enc.result());
      return Promise.resolve(err(Status.ConnectionClosed));
    },
    listener: {
      connect() {
        return Promise.resolve(Status.Success);
      },
      connected() {
        return false;
      },
      disconnect() {},
    },
  };
}

// The request captured from the last call.
function one(sent: Uint8Array[]): Uint8Array {
  const raw = sent[0];
  if (raw === undefined) throw new Error("no req");
  return raw;
}

function peekRlm(bytes: Uint8Array): Uint8Array {
  const dec = new Decoder(bytes);
  const [, as] = dec.readStruct(authTimestampCodec);
  if (as !== Status.Success) throw new Error(`auth ${as}`);
  const [cur, cs] = dec.readStruct(peekCursorCodec);
  if (cs !== Status.Success || cur === undefined) throw new Error(`peek ${cs}`);
  return cur.rlm;
}

// Host rlm from a captured PULL body.
function pullRlm(bytes: Uint8Array): Uint8Array {
  const dec = new Decoder(bytes);
  const [, as] = dec.readStruct(authTimestampCodec);
  if (as !== Status.Success) throw new Error(`auth ${as}`);
  const [req, rs] = dec.readStruct(pullReqCodec);
  if (rs !== Status.Success || req === undefined) throw new Error(`pull ${rs}`);
  return req.rlm;
}

// Peek-item head bytes for a sealed bag.
function peekHead(bag: IBag): Uint8Array {
  const enc = new Encoder();
  const st = enc.writeStruct(peekItemHeadCodec, {
    sig: bag.sig,
    kdm: bag.kdm,
    headCph: bag.headCph,
  });
  if (st !== Status.Success) throw new Error(`head ${st}`);
  return enc.result();
}

Deno.test("client realm kdm", async () => {
  const seed = await libsodiumCrypto.gen256BitSecureRandomSeed();
  const [enclave, est] = Enclave.fromBytes(seed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }
  const host: IHostConnectionInfo<URL> = {
    handle: new URL("http://localhost"),
    label: "h",
    idx: 0,
  };
  const hostKDM: IKDM = { label: host.label, index: 0 };
  const sent: Uint8Array[] = [];
  const client = new DiplomaticClientAPI(
    enclave,
    libsodiumCrypto,
    host,
    new Clock(),
    transport(sent),
    () => Promise.resolve(Status.Success),
  );

  const [home, hs] = await enclave.hostRlm(nullKDM, hostKDM);
  const [box, bs] = await enclave.hostRlm(inbox, hostKDM);
  if (hs !== Status.Success || bs !== Status.Success) {
    throw new Error(`rlm ${hs} ${bs}`);
  }
  if (home === undefined || box === undefined) throw new Error("rlm");

  sent.length = 0;
  const [, peekHome] = await client.peek(4);
  assertEquals(peekHome, Status.ConnectionClosed);
  assert(bytesEqual(peekRlm(one(sent)), home));

  sent.length = 0;
  const [, peekBox] = await client.peek(4, inbox);
  assertEquals(peekBox, Status.ConnectionClosed);
  const peeked = peekRlm(one(sent));
  assert(bytesEqual(peeked, box));
  assert(!bytesEqual(peeked, home));

  sent.length = 0;
  const [, pullBox] = await client.pull([1, 2], inbox);
  assertEquals(pullBox, Status.ConnectionClosed);
  assert(bytesEqual(pullRlm(one(sent)), box));

  const [msg, ms] = await genInsert({
    now: new Date(),
    bod: new Uint8Array([1, 2, 3]),
    crypto: libsodiumCrypto,
  });
  if (ms !== Status.Success || msg === undefined) throw new Error(`msg ${ms}`);
  const [bag, bagSt] = await client.seal(msg, inbox);
  if (bagSt !== Status.Success || bag === undefined) {
    throw new Error(`seal ${bagSt}`);
  }
  assert(bytesEqual(bag.rlm, box));

  const [id, ist] = await client.identity();
  if (ist !== Status.Success || id === undefined) throw new Error(`id ${ist}`);
  const verifyKey = await libsodiumCrypto.importVerifyKey(id.publicKey);
  const item = { seq: 1, headCph: peekHead(bag) };
  const [opened, ost] = await decryptPeekItem(
    item,
    verifyKey,
    enclave,
    libsodiumCrypto,
    bag.rlm,
    inbox,
  );
  assertEquals(ost, Status.Success);
  assert(opened !== undefined && opened.headEnc.length > 0);
  const [, wrong] = await decryptPeekItem(
    item,
    verifyKey,
    enclave,
    libsodiumCrypto,
    bag.rlm,
    nullKDM,
  );
  assert(wrong !== Status.Success);
});
