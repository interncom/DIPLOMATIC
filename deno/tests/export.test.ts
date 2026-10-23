// Export file key: one nonce, and one realm key per realm under that key.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { fileIndexItemCodec } from "../../shared/codecs/fileIndexItem.ts";
import { hashBytes, Status } from "../../shared/consts.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { Exim, type IExportRealm } from "../../shared/crypto/exim.ts";
import { genInsertHead } from "../../shared/message.ts";
import crypto from "../src/crypto.ts";

const seed = new Uint8Array(32).fill(0x21);

// One insert, with its plaintext body.
async function note(text: string, when: number) {
  const body = new TextEncoder().encode(text);
  const [head, st] = await genInsertHead({
    now: new Date(when),
    bod: body,
    crypto,
    typ: "note",
  });
  if (st !== Status.Success || head === undefined) {
    throw new Error(`head ${st}`);
  }
  return { head, body };
}

function enclave(): Enclave {
  const [enc, st] = Enclave.fromBytes(seed);
  if (st !== Status.Success || enc === undefined) {
    throw new Error(`enclave ${st}`);
  }
  return enc;
}

Deno.test("export key is a child of the nonce", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(3);
  const other = new Uint8Array(hashBytes).fill(4);
  const [a, sa] = await enc.exportKey(nonce);
  const [b, sb] = await enc.exportKey(nonce);
  const [c, sc] = await enc.exportKey(other);
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  assertEquals(sc, Status.Success);
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error("missing export key");
  }
  try {
    assert(bytesEqual(a, b));
    assert(!bytesEqual(a, c));
  } finally {
    a.fill(0);
    b.fill(0);
    c.fill(0);
  }
  const [bad, stBad] = await enc.exportKey(new Uint8Array(8));
  assertEquals(stBad, Status.InvalidParam);
  assertEquals(bad, undefined);
});

Deno.test("exportFile opens with the same enclave", async () => {
  const enc = enclave();
  const bod = new TextEncoder().encode("hello");
  const [head, hst] = await genInsertHead({
    now: new Date(1_700_000_000_000),
    bod,
    crypto,
    typ: "note",
  });
  if (hst !== Status.Success || head === undefined) {
    throw new Error(`head ${hst}`);
  }
  const [file, fst] = await Exim.exportFile(enc, crypto, [{
    realm: nullKDM,
    msgs: [{ head, body: bod }],
  }]);
  if (fst !== Status.Success || file === undefined) {
    throw new Error(`file ${fst}`);
  }
  const [nonce, nst] = Exim.exportNonce(file);
  if (nst !== Status.Success || nonce === undefined) {
    throw new Error(`nonce ${nst}`);
  }
  const [key, kst] = await enc.exportKey(nonce);
  if (kst !== Status.Success || key === undefined) {
    throw new Error(`key ${kst}`);
  }
  try {
    const [realms, mst] = await Exim.decodeFile(file, crypto, key);
    if (mst !== Status.Success || realms === undefined) {
      throw new Error(`decode ${mst}`);
    }
    const part = realms[0];
    const msg = part?.msgs[0];
    if (part === undefined || msg === undefined || msg.body === undefined) {
      throw new Error("empty decode");
    }
    assertEquals(realms.length, 1);
    assertEquals(part.realm.label, "");
    assertEquals(part.realm.index, 0);
    assert(bytesEqual(msg.body, bod));
  } finally {
    key.fill(0);
  }
});

Deno.test("file key opens only its nonce", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(9);
  const [key, st] = await enc.exportKey(nonce);
  assertEquals(st, Status.Success);
  if (key === undefined) throw new Error("missing export key");
  const bod = new TextEncoder().encode("hello");
  const [head, hst] = await genInsertHead({
    now: new Date(1_700_000_000_000),
    bod,
    crypto,
    typ: "note",
  });
  assertEquals(hst, Status.Success);
  if (head === undefined) throw new Error("missing head");
  const notes = { label: "notes", index: 2 };
  let file: Uint8Array;
  try {
    const [sealed, sst] = await Exim.sealExport(
      [{ realm: notes, msgs: [{ head, body: bod }] }],
      crypto,
      key,
      nonce,
    );
    assertEquals(sst, Status.Success);
    if (sealed === undefined) throw new Error("missing file");
    file = sealed;

    const [read, rst] = Exim.exportNonce(file);
    assertEquals(rst, Status.Success);
    if (read === undefined) throw new Error("missing nonce");
    assert(bytesEqual(read, nonce));

    const [realms, mst] = await Exim.decodeFile(file, crypto, key);
    if (mst !== Status.Success || realms === undefined) {
      throw new Error(`decode ${mst}`);
    }
    const part = realms[0];
    const msg = part?.msgs[0];
    if (part === undefined || msg === undefined || msg.body === undefined) {
      throw new Error("empty decode");
    }
    assertEquals(realms.length, 1);
    assertEquals(part.msgs.length, 1);
    assert(bytesEqual(msg.body, bod));
    assertEquals(msg.head.typ, "note");
    assertEquals(part.realm.label, notes.label);
    assertEquals(part.realm.index, notes.index);

    const swapped = file.slice();
    swapped[0] ^= 0xff;
    const [, wrong] = await Exim.decodeFile(swapped, crypto, key);
    assert(wrong !== Status.Success);
  } finally {
    key.fill(0);
  }
});

Deno.test("export keeps each realm", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(5);
  const [key, st] = await enc.exportKey(nonce);
  assertEquals(st, Status.Success);
  if (key === undefined) throw new Error("missing export key");
  const kdms = [
    nullKDM,
    { label: "notes", index: 2 },
    { label: "pics", index: 0 },
  ];
  const realms: IExportRealm[] = [];
  try {
    for (let i = 0; i < kdms.length; i++) {
      const bod = new TextEncoder().encode(`body ${i}`);
      const [head, hst] = await genInsertHead({
        now: new Date(1_700_000_000_000 + i),
        bod,
        crypto,
        typ: "note",
      });
      if (hst !== Status.Success || head === undefined) {
        throw new Error(`head ${hst}`);
      }
      const realm = kdms[i];
      if (realm === undefined) throw new Error("realm");
      realms.push({ realm, msgs: [{ head, body: bod }] });
    }
    const notes = realms[1];
    if (notes === undefined) throw new Error("notes");
    const extra = new TextEncoder().encode("notes again");
    const [head2, hst2] = await genInsertHead({
      now: new Date(1_700_000_000_009),
      bod: extra,
      crypto,
      typ: "note",
    });
    if (hst2 !== Status.Success || head2 === undefined) {
      throw new Error(`head ${hst2}`);
    }
    notes.msgs.push({ head: head2, body: extra });
    const [file, fst] = await Exim.sealExport(realms, crypto, key, nonce);
    assertEquals(fst, Status.Success);
    if (file === undefined) throw new Error("missing file");
    const [out, ost] = await Exim.decodeFile(file, crypto, key);
    if (ost !== Status.Success || out === undefined) {
      throw new Error(`decode ${ost}`);
    }
    assertEquals(out.length, realms.length);
    for (let i = 0; i < realms.length; i++) {
      const got = out[i];
      const want = realms[i];
      if (got === undefined || want === undefined) {
        throw new Error("missing realm");
      }
      assertEquals(got.realm.label, want.realm.label);
      assertEquals(got.realm.index, want.realm.index);
      assertEquals(got.msgs.length, want.msgs.length);
      for (let j = 0; j < want.msgs.length; j++) {
        const msg = got.msgs[j];
        const src = want.msgs[j];
        if (msg === undefined || src === undefined || msg.body === undefined) {
          throw new Error("missing msg");
        }
        assert(bytesEqual(msg.body, src.body ?? new Uint8Array()));
      }
    }
  } finally {
    key.fill(0);
  }
});

Deno.test("empty export is a signed header", async () => {
  const enc = enclave();
  const [file, fst] = await Exim.exportFile(enc, crypto, []);
  assertEquals(fst, Status.Success);
  if (fst !== Status.Success || file === undefined) {
    throw new Error(`file ${fst}`);
  }
  const [nonce, nst] = Exim.exportNonce(file);
  if (nst !== Status.Success || nonce === undefined) {
    throw new Error(`nonce ${nst}`);
  }
  const [key, kst] = await enc.exportKey(nonce);
  if (kst !== Status.Success || key === undefined) {
    throw new Error(`key ${kst}`);
  }
  try {
    const [realms, mst] = await Exim.decodeFile(file, crypto, key);
    if (mst !== Status.Success || realms === undefined) {
      throw new Error(`decode ${mst}`);
    }
    assertEquals(realms.length, 0);
    const swapped = file.slice();
    swapped[0] ^= 0xff;
    const [, wrong] = await Exim.decodeFile(swapped, crypto, key);
    assert(wrong !== Status.Success);
  } finally {
    key.fill(0);
  }
});

Deno.test("a duplicated head fails its realm hash", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(7);
  const [key, st] = await enc.exportKey(nonce);
  assertEquals(st, Status.Success);
  if (key === undefined) throw new Error("missing export key");
  try {
    const [file, fst] = await Exim.sealExport(
      [{
        realm: nullKDM,
        msgs: [
          await note("one", 1_700_000_000_000),
          await note("two", 1_700_000_000_001),
        ],
      }],
      crypto,
      key,
      nonce,
    );
    assertEquals(fst, Status.Success);
    if (fst !== Status.Success || file === undefined) {
      throw new Error(`file ${fst}`);
    }
    const [parsed, pst] = fileCodec.decode(new Decoder(file));
    assertEquals(pst, Status.Success);
    if (pst !== Status.Success) return;
    const dec = new Decoder(parsed.chunks);
    const [a, sa] = dec.readStruct(fileIndexItemCodec);
    const [, sb] = dec.readStruct(fileIndexItemCodec);
    assertEquals(sa, Status.Success);
    assertEquals(sb, Status.Success);
    if (sa !== Status.Success || sb !== Status.Success) return;
    const tail = parsed.chunks.subarray(dec.consumed());
    const heads = new Encoder();
    assertEquals(heads.writeStruct(fileIndexItemCodec, a), Status.Success);
    assertEquals(heads.writeStruct(fileIndexItemCodec, a), Status.Success);
    const headBytes = heads.result();
    const chunks = new Uint8Array(headBytes.length + tail.length);
    chunks.set(headBytes, 0);
    chunks.set(tail, headBytes.length);
    const encFile = new Encoder();
    assertEquals(
      encFile.writeStruct(fileCodec, { head: parsed.head, chunks }),
      Status.Success,
    );
    const [, tampered] = await Exim.decodeFile(encFile.result(), crypto, key);
    assertEquals(tampered, Status.HashMismatch);
  } finally {
    key.fill(0);
  }
});

Deno.test("a short file fails closed", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(8);
  const [key, st] = await enc.exportKey(nonce);
  assertEquals(st, Status.Success);
  if (key === undefined) throw new Error("missing export key");
  try {
    const [file, fst] = await Exim.sealExport(
      [
        { realm: nullKDM, msgs: [await note("one", 1_700_000_000_000)] },
        {
          realm: { label: "notes", index: 1 },
          msgs: [await note("two", 1_700_000_000_001)],
        },
      ],
      crypto,
      key,
      nonce,
    );
    assertEquals(fst, Status.Success);
    if (fst !== Status.Success || file === undefined) {
      throw new Error(`file ${fst}`);
    }
    const [, shortSt] = await Exim.decodeFile(
      file.subarray(0, file.length - 1),
      crypto,
      key,
    );
    assert(shortSt !== Status.Success);

    const [parsed, pst] = fileCodec.decode(new Decoder(file));
    assertEquals(pst, Status.Success);
    if (pst !== Status.Success) return;
    const row = parsed.head.realms[0];
    if (row === undefined) throw new Error("realm");
    const dec = new Decoder(parsed.chunks);
    let body = 0;
    for (let i = 0; i < row.num; i++) {
      const [item, ist] = dec.readStruct(fileIndexItemCodec);
      assertEquals(ist, Status.Success);
      if (ist !== Status.Success) return;
      body += item.lenBody;
    }
    const headerLen = file.length - parsed.chunks.length;
    const cut = file.subarray(0, headerLen + dec.consumed() + body);
    const [, cutSt] = await Exim.decodeFile(cut, crypto, key);
    assert(cutSt !== Status.Success);
  } finally {
    key.fill(0);
  }
});

Deno.test("export rejects an empty realm", async () => {
  const enc = enclave();
  const nonce = new Uint8Array(hashBytes).fill(6);
  const [key, st] = await enc.exportKey(nonce);
  assertEquals(st, Status.Success);
  if (key === undefined) throw new Error("missing export key");
  try {
    const [file, fst] = await Exim.sealExport(
      [{ realm: nullKDM, msgs: [] }],
      crypto,
      key,
      nonce,
    );
    assertEquals(fst, Status.InvalidMessage);
    assertEquals(file, undefined);
  } finally {
    key.fill(0);
  }
});
