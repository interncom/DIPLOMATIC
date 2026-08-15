import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { htob } from "../../shared/binary.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import { asX25519Sk, x25519, x25519Pub } from "../../shared/crypto/x25519.ts";
import { Status } from "../../shared/consts.ts";

// RFC 7748 §6.1
const ALICE = htob(
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
);
const BOB = htob(
  "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
);
const ALICE_PUB = htob(
  "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
);
const BOB_PUB = htob(
  "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
);
const SHARED = htob(
  "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
);

function skOf(bytes: Uint8Array) {
  const [sk, st] = asX25519Sk(bytes);
  if (st !== Status.Success || sk === undefined) throw new Error(`sk ${st}`);
  return sk;
}

Deno.test("x25519 RFC 7748 alice/bob", () => {
  const alice = skOf(ALICE);
  const bob = skOf(BOB);
  assertEquals(x25519Pub(alice), ALICE_PUB);
  assertEquals(x25519Pub(bob), BOB_PUB);
  assertEquals(x25519(alice, BOB_PUB), SHARED);
  assertEquals(x25519(bob, ALICE_PUB), SHARED);
});

Deno.test("x25519 gen checks pub; ECDH agrees", async () => {
  const n = new NobleCrypto();
  const a = await n.genX25519();
  const b = await n.genX25519();
  assertEquals(a.pub, x25519Pub(a.priv));
  const s1 = await n.x25519Shared(a.priv, b.pub);
  const s2 = await n.x25519Shared(b.priv, a.pub);
  assertEquals(s1, s2);
});

Deno.test("asX25519Sk brands 32 B only", () => {
  const [ok, s] = asX25519Sk(new Uint8Array(32));
  assertEquals(s, Status.Success);
  if (ok === undefined) throw new Error("brand");
  assertEquals(ok.byteLength, 32);
  for (const n of [0, 16, 31, 33]) {
    const [, st] = asX25519Sk(new Uint8Array(n));
    assertEquals(st, Status.InvalidParam);
  }
});

// RFC 7748 §5.2
Deno.test("x25519 RFC 7748 §5.2", () => {
  const sk = skOf(htob(
    "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
  ));
  const u = htob(
    "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
  );
  assertEquals(
    x25519(sk, u),
    htob("c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552"),
  );
});

Deno.test("x25519Shared matches RFC 7748 alice/bob", async () => {
  const n = new NobleCrypto();
  const s1 = await n.x25519Shared(skOf(ALICE), BOB_PUB);
  const s2 = await n.x25519Shared(skOf(BOB), ALICE_PUB);
  assertEquals(s1, SHARED);
  assertEquals(s2, SHARED);
});
