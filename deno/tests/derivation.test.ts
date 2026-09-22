import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { kdmCodec } from "../../shared/codecs/kdm.ts";
import { Status } from "../../shared/consts.ts";
import {
  deriveChild,
  deriveKey,
  derivePDK,
  nullKDM,
  Purpose,
} from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";

const parent = new Uint8Array(32).fill(7);

Deno.test("PDKs differ by purpose", async () => {
  const [a, sa] = await derivePDK({ parent, purpose: Purpose.Identity });
  const [b, sb] = await derivePDK({ parent, purpose: Purpose.Cipher });
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  assert(!bytesEqual(a, b));
  a.fill(0);
  b.fill(0);
});

Deno.test("same parent+purpose yields same PDK", async () => {
  const [a, sa] = await derivePDK({ parent, purpose: Purpose.Identity });
  const [b, sb] = await derivePDK({ parent, purpose: Purpose.Identity });
  assertEquals(sa, Status.Success);
  assertEquals(sb, Status.Success);
  assert(bytesEqual(a, b));
  a.fill(0);
  b.fill(0);
});

Deno.test("child keys differ by KDM label and index", async () => {
  const [pdk, pst] = await derivePDK({ parent, purpose: Purpose.Identity });
  assertEquals(pst, Status.Success);
  const [l0, s0] = await deriveChild({
    pdk,
    kdm: { label: "host", index: 0 },
  });
  const [l1, s1] = await deriveChild({
    pdk,
    kdm: { label: "other", index: 0 },
  });
  const [i1, si] = await deriveChild({ pdk, kdm: { label: "host", index: 1 } });
  const [def, sd] = await deriveChild({ pdk, kdm: nullKDM });
  assertEquals(s0, Status.Success);
  assertEquals(s1, Status.Success);
  assertEquals(si, Status.Success);
  assertEquals(sd, Status.Success);
  assert(!bytesEqual(l0, l1));
  assert(!bytesEqual(l0, i1));
  assert(!bytesEqual(l0, def));
  pdk.fill(0);
});

Deno.test("null-KDM child is not the PDK", async () => {
  const [pdk, pst] = await derivePDK({ parent, purpose: Purpose.Fingerprint });
  assertEquals(pst, Status.Success);
  const [child, st] = await deriveChild({ pdk, kdm: nullKDM });
  assertEquals(st, Status.Success);
  assert(!bytesEqual(pdk, child));
  pdk.fill(0);
});

Deno.test("deriveKey isolates identity vs cipher", async () => {
  const kdm = { label: "x", index: 0 };
  const [idnt, ist] = await deriveKey({
    parent,
    purpose: Purpose.Identity,
    kdm,
  });
  const [again, ast] = await deriveKey({
    parent,
    purpose: Purpose.Identity,
    kdm,
  });
  const [cph, cst] = await deriveKey({
    parent,
    purpose: Purpose.Cipher,
    kdm,
  });
  assertEquals(ist, Status.Success);
  assertEquals(ast, Status.Success);
  assertEquals(cst, Status.Success);
  assert(bytesEqual(idnt, again));
  assert(!bytesEqual(idnt, cph));
});

Deno.test("Enclave.fingerprint matches null-KDM fingerprint child", async () => {
  const [enc, est] = Enclave.fromBytes(parent);
  assertEquals(est, Status.Success);
  const [fp, st] = await enc.fingerprint();
  const [child, cst] = await deriveKey({
    parent,
    purpose: Purpose.Fingerprint,
    kdm: nullKDM,
  });
  assertEquals(st, Status.Success);
  assertEquals(cst, Status.Success);
  assert(bytesEqual(fp, child));
});

Deno.test("KDM codec roundtrip", () => {
  const original = { label: "host", index: 3 };
  const enc = new Encoder();
  assertEquals(kdmCodec.encode(enc, original), Status.Success);
  const [got, st] = kdmCodec.decode(new Decoder(enc.result()));
  assertEquals(st, Status.Success);
  assertEquals(got, original);
});

Deno.test("deriveChild differs by raw KDM bytes", async () => {
  const [pdk, pst] = await derivePDK({ parent, purpose: Purpose.BindTag });
  assertEquals(pst, Status.Success);
  const bytes = new Uint8Array([1, 2, 3]);
  const [a, sa] = await deriveChild({ pdk, kdm: bytes });
  const [same, ss] = await deriveChild({ pdk, kdm: bytes.slice() });
  const [b, sb] = await deriveChild({ pdk, kdm: new Uint8Array([1, 2, 4]) });
  assertEquals(sa, Status.Success);
  assertEquals(ss, Status.Success);
  assertEquals(sb, Status.Success);
  assert(bytesEqual(a, same));
  assert(!bytesEqual(a, b));
  pdk.fill(0);
});

Deno.test("deriveChild structured KDM matches encoded bytes", async () => {
  const [pdk, pst] = await derivePDK({ parent, purpose: Purpose.Identity });
  assertEquals(pst, Status.Success);
  const kdm = { label: "host", index: 2 };
  const enc = new Encoder();
  assertEquals(kdmCodec.encode(enc, kdm), Status.Success);
  const [fromStruct, sst] = await deriveChild({ pdk, kdm });
  const [fromBytes, bst] = await deriveChild({ pdk, kdm: enc.result() });
  assertEquals(sst, Status.Success);
  assertEquals(bst, Status.Success);
  assert(bytesEqual(fromStruct, fromBytes));
  pdk.fill(0);
});
