import { describe, expect, test } from "vitest";
import { decode, encode } from "@msgpack/msgpack";
import { Exim } from "../src/shared/exim";
import { makeEID } from "../src/shared/codecs/eid";
import { Status } from "../src/shared/consts";
import libsodiumCrypto from "../src/crypto";
import type { IMessageHead } from "../src/shared/types";

const codec = { encode, decode };

describe("Exim.hoistTyp", () => {
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
    const [out] = await Exim.hoistTyp(
      [{ head, body: oldBody }],
      libsodiumCrypto,
      codec,
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
    const out = await Exim.hoistTyp(
      [{ head: rawHead, body: raw }, { head: delHead }],
      libsodiumCrypto,
      codec,
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
    const [out] = await Exim.hoistTyp(
      [{ head, body }],
      libsodiumCrypto,
      codec,
    );
    expect(out.head.typ).toBe("note");
    expect(out.body).toEqual(body);
  });
});
