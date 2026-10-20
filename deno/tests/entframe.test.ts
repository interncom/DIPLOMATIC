// Pre-v0.24 msgpack ent bodies become the ent frame.

import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { decode, encode } from "npm:@msgpack/msgpack@3.1.3";
import { blake3 } from "@noble/hashes/blake3";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder } from "../../shared/codec.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { encodeEnt, entCodec } from "../../shared/codecs/ent.ts";
import { Status } from "../../shared/consts.ts";
import { checksumEntInfo, entFrameMsgs } from "../../tools/entframe/migrate.ts";
import type { IMessageHead } from "../../shared/types.ts";

const pack = { encode, decode };

function hash(data: Uint8Array): Promise<Uint8Array> {
  return Promise.resolve(blake3(data));
}

function head(typ = "goal"): IMessageHead {
  const [eid, st] = makeEID({
    id: new Uint8Array(8).fill(0x22),
    ts: new Date(0),
  });
  if (st !== Status.Success) throw new Error("eid");
  return { eid, off: 0, ctr: 0, typ, len: 1, hsh: new Uint8Array(32) };
}

Deno.test("msgpack ent body becomes an ent frame", async () => {
  const [pid, sp] = makeEID({
    id: new Uint8Array(8).fill(0x11),
    ts: new Date(1_700_000_000_000),
  });
  if (sp !== Status.Success) throw new Error("pid");
  const old = encode({
    body: { text: "walk" },
    pid,
    tags: ["name:a"],
  });
  const h = head();
  const [msgs, st] = await entFrameMsgs(
    [{ head: h, body: old }, { head: h, body: undefined }],
    hash,
    pack,
  );
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  assertEquals(msgs[1].body, undefined);
  const bod = msgs[0].body;
  if (bod === undefined) throw new Error("body");
  const dec = new Decoder(bod);
  const [ent, se] = dec.readStruct(entCodec);
  assertEquals(se, Status.Success);
  if (se !== Status.Success) return;
  assertEquals(dec.done(), true);
  assertEquals(bytesEqual(ent.pid ?? new Uint8Array(), pid), true);
  assertEquals(ent.tags, ["name:a"]);
  assertEquals(decode(ent.body ?? new Uint8Array()), { text: "walk" });
  assertEquals(msgs[0].head.typ, "goal");
  assertEquals(msgs[0].head.len, bod.length);
  assertEquals(
    bytesEqual(msgs[0].head.hsh ?? new Uint8Array(), blake3(bod)),
    true,
  );
});

Deno.test("empty head typ takes type from the old map", async () => {
  const old = encode({ type: "goal", body: { text: "a" } });
  const [msgs, st] = await entFrameMsgs(
    [{ head: head(""), body: old }],
    hash,
    pack,
  );
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  assertEquals(msgs[0].head.typ, "goal");
});

Deno.test("a frame is left unchanged", async () => {
  const old = encode({ body: { text: "a" } });
  const [once, st] = await entFrameMsgs(
    [{ head: head(), body: old }],
    hash,
    pack,
  );
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const [twice, st2] = await entFrameMsgs(once, hash, pack);
  assertEquals(st2, Status.Success);
  if (st2 !== Status.Success) return;
  assertEquals(twice[0].body, once[0].body);
  assertEquals(twice[0].head, once[0].head);
});

Deno.test("a raw application body is not wrapped again", async () => {
  const raw = new Uint8Array([1, 2, 3]);
  const old = encode({ body: raw });
  const [msgs, st] = await entFrameMsgs(
    [{ head: head(), body: old }],
    hash,
    pack,
  );
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const bod = msgs[0].body;
  if (bod === undefined) throw new Error("body");
  const [ent, se] = new Decoder(bod).readStruct(entCodec);
  assertEquals(se, Status.Success);
  if (se !== Status.Success) return;
  assertEquals(ent.body, raw);
});

Deno.test("null gid pid and tags and an empty map become an ent frame", async () => {
  const src = [
    {
      head: head(),
      body: encode({
        body: { text: "fix flicker", note: null, scale: null },
        gid: null,
        pid: null,
        tags: null,
      }),
    },
    { head: head(), body: encode({}) },
  ];
  const [next, st] = await entFrameMsgs(src, hash, pack);
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const bod = next[0].body;
  if (bod === undefined) throw new Error("body");
  const [ent, se] = new Decoder(bod).readStruct(entCodec);
  assertEquals(se, Status.Success);
  if (se !== Status.Success) return;
  assertEquals(ent.pid, undefined);
  assertEquals(ent.tags, undefined);
  assertEquals(decode(ent.body ?? new Uint8Array()), {
    text: "fix flicker",
    note: null,
    scale: null,
  });
  const emptyBod = next[1].body;
  if (emptyBod === undefined) throw new Error("empty");
  const [emptyEnt, see] = new Decoder(emptyBod).readStruct(entCodec);
  assertEquals(see, Status.Success);
  if (see !== Status.Success) return;
  assertEquals(emptyEnt.body, undefined);
  const [a, sa] = await checksumEntInfo(src, hash, pack);
  const [b, sb] = await checksumEntInfo(next, hash, pack);
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  if (a === undefined || b === undefined) throw new Error("sum");
  assertEquals(bytesEqual(a, b), true);
});

Deno.test("an unexpected key rejects the file", async () => {
  const old = encode({ body: { text: "a" }, gid: "20260902" });
  const [, st] = await entFrameMsgs([{ head: head(), body: old }], hash, pack);
  assertEquals(st, Status.InvalidMessage);
});

Deno.test("info checksum matches the ent-frame rewrite", async () => {
  const [pid, sp] = makeEID({
    id: new Uint8Array(8).fill(0x11),
    ts: new Date(1_700_000_000_000),
  });
  if (sp !== Status.Success) throw new Error("pid");
  const src = [
    {
      head: head(),
      body: encode({
        body: { text: "walk", done: false },
        pid,
        tags: ["name:a"],
      }),
    },
    { head: head(""), body: encode({ type: "goal", body: { n: 1 } }) },
    { head: head(), body: encode({ body: new Uint8Array([1, 2, 3]) }) },
    { head: head(), body: undefined },
    {
      head: { ...head(), len: 99, hsh: new Uint8Array(32).fill(7) },
      body: encode({ body: { text: "z" } }),
    },
  ];
  const [next, st] = await entFrameMsgs(src, hash, pack);
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const [a, sa] = await checksumEntInfo(src, hash, pack);
  const [b, sb] = await checksumEntInfo(next, hash, pack);
  const [c, sc] = await checksumEntInfo([...src].reverse(), hash, pack);
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  assertEquals(sc, Status.Success);
  if (a === undefined || b === undefined || c === undefined) {
    throw new Error("sum");
  }
  assertEquals(bytesEqual(a, b), true);
  assertEquals(bytesEqual(a, c), true);
  const tweaked = next.map((m) => ({
    head: { ...m.head, len: 1, hsh: new Uint8Array(32).fill(9) },
    body: m.body,
  }));
  const [d, sd] = await checksumEntInfo(tweaked, hash, pack);
  assertEquals(sd, Status.Success);
  if (d === undefined) throw new Error("sum");
  assertEquals(bytesEqual(a, d), true);
});

Deno.test("info checksum changes when a tag is dropped", async () => {
  const old = encode({ body: { text: "a" }, tags: ["name:a"] });
  const src = [{ head: head(), body: old }];
  const [next, st] = await entFrameMsgs(src, hash, pack);
  assertEquals(st, Status.Success);
  if (st !== Status.Success) return;
  const bod = next[0].body;
  if (bod === undefined) throw new Error("body");
  const [ent, se] = new Decoder(bod).readStruct(entCodec);
  assertEquals(se, Status.Success);
  if (se !== Status.Success || ent === undefined) return;
  const [stripped, ss] = encodeEnt({ body: ent.body });
  assertEquals(ss, Status.Success);
  if (ss !== Status.Success) return;
  const [a, sa] = await checksumEntInfo(next, hash, pack);
  const [b, sb] = await checksumEntInfo(
    [{ head: next[0].head, body: stripped }],
    hash,
    pack,
  );
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  if (a === undefined || b === undefined) throw new Error("sum");
  assertEquals(bytesEqual(a, b), false);
});
