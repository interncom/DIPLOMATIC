import { assert, assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { eidCodec, makeEID } from "../../shared/codecs/eid.ts";
import { Status } from "../../shared/consts.ts";

Deno.test("eid roundtrip", async () => {
  const eidObj = {
    id: new Uint8Array(16).fill(0xdd),
    ts: new Date(987654321000),
  };
  const [_original, stat] = makeEID(eidObj);
  assertEquals(stat, Status.Success);
  if (stat !== Status.Success) return;

  const enc = new Encoder();
  enc.writeStruct(eidCodec, eidObj);
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [decoded, status] = dec.readStruct(eidCodec);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(decoded.id, eidObj.id);
  assertEquals(decoded.ts.getTime(), eidObj.ts.getTime());
  assertEquals(dec.done(), true);
});

Deno.test("eid decode invalid id length", () => {
  const enc = new Encoder();
  enc.writeVarBytes(new Uint8Array(8)); // Wrong id length
  enc.writeDate(new Date());
  const encoded = enc.result();
  const dec = new Decoder(encoded);
  const [result, status] = dec.readStruct(eidCodec);
  assertEquals(status, Status.Success); // Should succeed since varbytes can be any length, but makeEID would fail in practice
  if (status !== Status.Success) return;
  // But the id is wrong length, which is fine for codec but not for EntityID
  assertEquals(result.id.length, 8);
});

Deno.test("makeEID success", () => {
  const eidObj = {
    id: new Uint8Array(16).fill(0x11),
    ts: new Date(0),
  };
  const [eid, status] = makeEID(eidObj);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assert(eid.length > 16); // varbytes length + id + date varint
});

Deno.test("makeEID with empty id", () => {
  const eidObj = {
    id: new Uint8Array(0),
    ts: new Date(0),
  };
  const [eid, status] = makeEID(eidObj);
  assertEquals(status, Status.Success);
  if (status !== Status.Success) return;
  assertEquals(eid.length > 0, true);
});
