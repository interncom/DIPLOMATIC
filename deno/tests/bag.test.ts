import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { openBag, sealBag } from "../../shared/bag.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { Status } from "../../shared/consts.ts";
import { asHostRlm, type HostRlm } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import type { IBag, IMessage } from "../../shared/types.ts";
import libsodiumCrypto from "../src/crypto.ts";

function hostRlm(fill: number): HostRlm {
  const [rlm, st] = asHostRlm(new Uint8Array(32).fill(fill));
  if (st !== Status.Success) throw new Error(`rlm ${st}`);
  return rlm;
}

Deno.test("bag", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("encodeBag", async () => {
    const op: IBag = {
      rlm: hostRlm(0x66),
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(bagCodec, op);
    const encoded = enc.result();
    // sig + rlm + kdm + varint(3) + varint(2) + headCph + bodyCph
    const expectedLen = 64 + 32 + 8 + 1 + 1 + 3 + 2;
    assertEquals(encoded.length, expectedLen);
    assertEquals(encoded.slice(0, 64), op.sig);
    assertEquals(encoded.slice(64, 96), op.rlm);
    assertEquals(encoded.slice(96, 104), op.kdm);
    assertEquals(encoded[104], 3);
    assertEquals(encoded.slice(105, 108), op.headCph);
    assertEquals(encoded[108], 2);
    assertEquals(encoded.slice(109, 111), op.bodyCph);
  });

  await t.step("decodeBag", async () => {
    const op: IBag = {
      rlm: hostRlm(0x66),
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(bagCodec, op);
    const encoded = enc.result();
    const decoder = new Decoder(encoded);
    const [decoded, status] = decoder.readStruct(bagCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(decoded.rlm, op.rlm);
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.kdm, op.kdm);
    assertEquals(decoded.headCph, op.headCph);
    assertEquals(decoded.bodyCph, op.bodyCph);
    assertEquals(decoder.done(), true);
  });

  await t.step("decodeBag error on short input", async () => {
    const short = new Uint8Array(70); // less than minimum
    try {
      const decoder = new Decoder(short);
      decoder.readStruct(bagCodec);
      throw new Error("Should have thrown");
    } catch {
      // Expected to fail on incomplete
    }
  });

  await t.step("seal and open round trip", async () => {
    // Setup enclave and keypair
    const seed = await crypto.gen256BitSecureRandomSeed();
    const [enclave, est] = Enclave.fromBytes(seed);
    if (est !== Status.Success) throw new Error(`enclave ${est}`);
    const [hostIdnt, ist] = await enclave.deriveIdentity({
      label: "test-host",
      index: 0,
    });
    if (ist !== Status.Success) throw new Error(`idnt ${ist}`);

    // Create a test message
    const id = await crypto.genRandomBytes(8);
    const eidObj = { id, ts: new Date(0) };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }

    const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
    const msg: IMessage = {
      eid,
      off: 0,
      ctr: 1,
      len: bod.length,
      bod,
    };

    // Seal the message
    const [bag, statBag] = await sealBag(msg, hostIdnt, crypto, enclave);
    if (statBag !== Status.Success) {
      assertEquals(statBag, Status.Success);
      return;
    }

    assertEquals(bag.rlm.byteLength, 32);
    const verifyKey = await crypto.importVerifyKey(hostIdnt.publicKey);
    const [miss, missSt] = await openBag(
      bag,
      verifyKey,
      crypto,
      enclave,
      { label: "other", index: 1 },
    );
    assertEquals(missSt, Status.NotFound);
    assertEquals(miss, undefined);

    // Open the bag (sealed under the null host KDM).
    const [openedMsg, status] = await openBag(
      bag,
      verifyKey,
      crypto,
      enclave,
    );
    if (status === Status.Success) {
      // openedMsg is IMessageWithHash

      // Verify contents
      assertEquals(openedMsg!.eid, msg.eid);
      assertEquals(openedMsg!.ctr, msg.ctr);
      assertEquals(openedMsg!.len, msg.len);
      assertEquals(openedMsg!.bod, msg.bod);
    } else {
      throw new Error(`Open bag failed with status ${status}`);
    }

    const swapped = bag.rlm.slice();
    swapped[0] ^= 0xff;
    const [badRlm, bst] = asHostRlm(swapped);
    if (bst !== Status.Success) throw new Error(`rlm ${bst}`);
    const [, bad] = await openBag(
      { ...bag, rlm: badRlm },
      verifyKey,
      crypto,
      enclave,
    );
    assertEquals(bad, Status.InvalidSignature);
  });
});
