import { describe, expect, test } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import {
  hoistTyp,
  v19MessageHeadCodec,
} from "../../tools/hoist-typ/hoist-typ";
import { Decoder, Encoder } from "../src/shared/codec";
import { messageHeadCodec } from "../src/shared/codecs/messageHead";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import libsodiumCrypto from "../src/crypto";
import type { IMessageHead } from "../src/shared/types";

describe("hoistTyp", () => {
  test("moves body.type onto the msg head and strips it from the body", async () => {
    const [eid, st] = makeEID({
      id: new Uint8Array(8).fill(1),
      ts: new Date(0),
    });
    expect(st).toBe(Status.Success);
    if (!eid) return;
    const oldBody = encode({
      type: "todo",
      body: { text: "x" },
      tags: ["a"],
    });
    const hsh = await libsodiumCrypto.blake3(oldBody);
    const head: IMessageHead = {
      eid,
      off: 0,
      ctr: 0,
      typ: "",
      len: oldBody.length,
      hsh,
    };
    const [out] = await hoistTyp(
      [{ head, body: oldBody }],
      libsodiumCrypto,
    );
    expect(out.head.typ).toBe("todo");
    expect(out.body).toBeDefined();
    if (!out.body) return;
    expect(decode(out.body)).toEqual({ body: { text: "x" }, tags: ["a"] });
    expect(out.head.len).toBe(out.body.length);
    expect(out.head.hsh).toEqual(await libsodiumCrypto.blake3(out.body));
  });

  test("leaves raw bodies and deletes unchanged", async () => {
    const [eid, st] = makeEID({
      id: new Uint8Array(8).fill(2),
      ts: new Date(0),
    });
    expect(st).toBe(Status.Success);
    if (!eid) return;
    const raw = new Uint8Array([1, 2, 3]);
    const rawHead: IMessageHead = {
      eid,
      off: 0,
      ctr: 0,
      typ: "",
      len: raw.length,
    };
    const delHead: IMessageHead = {
      eid,
      off: 1,
      ctr: 1,
      typ: "",
      len: 0,
    };
    const out = await hoistTyp(
      [{ head: rawHead, body: raw }, { head: delHead }],
      libsodiumCrypto,
    );
    expect(out[0].head.typ).toBe("");
    expect(out[0].body).toEqual(raw);
    expect(out[1].body).toBeUndefined();
    expect(out[1].head.typ).toBe("");
  });

  test("is idempotent when typ is already on the head", async () => {
    const [eid, st] = makeEID({
      id: new Uint8Array(8).fill(3),
      ts: new Date(0),
    });
    expect(st).toBe(Status.Success);
    if (!eid) return;
    const body = encode({ body: { text: "y" } });
    const head: IMessageHead = {
      eid,
      off: 0,
      ctr: 0,
      typ: "note",
      len: body.length,
    };
    const [out] = await hoistTyp(
      [{ head, body }],
      libsodiumCrypto,
    );
    expect(out.head.typ).toBe("note");
    expect(out.body).toEqual(body);
  });
});

describe("v19MessageHeadCodec", () => {
  test("roundtrips a 0.19 insert head (no typ field)", async () => {
    const [eid, st] = makeEID({
      id: new Uint8Array(8).fill(9),
      ts: new Date(0),
    });
    expect(st).toBe(Status.Success);
    if (!eid) return;
    const hsh = new Uint8Array(32).fill(0xab);
    const original: IMessageHead = {
      eid,
      off: 0,
      ctr: 0,
      len: 4,
      hsh,
    };
    const enc = new Encoder();
    expect(enc.writeStruct(v19MessageHeadCodec, original)).toBe(Status.Success);
    const dec = new Decoder(enc.result());
    const [decoded, status] = dec.readStruct(v19MessageHeadCodec);
    expect(status).toBe(Status.Success);
    expect(decoded?.eid).toEqual(eid);
    expect(decoded?.off).toBe(0);
    expect(decoded?.typ).toBeUndefined();
    expect(decoded?.hsh).toEqual(hsh);
    expect(dec.done()).toBe(true);
  });

  test("current codec rejects a 0.19 insert head", async () => {
    const [eid, st] = makeEID({
      id: new Uint8Array(8).fill(9),
      ts: new Date(0),
    });
    expect(st).toBe(Status.Success);
    if (!eid) return;
    const enc = new Encoder();
    enc.writeStruct(v19MessageHeadCodec, {
      eid,
      off: 0,
      ctr: 0,
      len: 1,
      hsh: new Uint8Array(32),
    });
    const dec = new Decoder(enc.result());
    const [, status] = dec.readStruct(messageHeadCodec);
    expect(status).toBe(Status.InvalidMessage);
  });
});
