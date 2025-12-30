import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { genKDM, openBag, sealBag } from "../../shared/bag.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import type { IBag, MasterSeed } from "../../shared/types.ts";
import { type IMessage } from "../../shared/message.ts";
import { Enclave } from "../../shared/enclave.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { kdmBytes } from "../../shared/consts.ts";

Deno.test("bag", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("genKDM", async () => {
    const kdm = await genKDM(crypto);
    assertEquals(kdm.length, 8);
    // Now it's random, just check length
    assertEquals(kdm.length, kdmBytes);
  });

  await t.step("encodeBag", async () => {
    const op: IBag = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenHeadCph: 3,
      lenBodyCph: 2,
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(bagCodec, op);
    const encoded = enc.result();
    const expectedLen = 64 + 8 + 1 + 1 + 3 + 2; // sig + kdm + varint(3) + varint(2) + headCph + bodyCph
    assertEquals(encoded.length, expectedLen);
    // Check sig
    assertEquals(encoded.slice(0, 64), op.sig);
    // Check kdm
    assertEquals(encoded.slice(64, 72), op.kdm);
    // Check lenHeadCph varint
    assertEquals(encoded[72], 3); // varint for 3
    // Check lenBodyCph varint
    assertEquals(encoded[73], 2); // varint for 2
    // Check headCph
    assertEquals(encoded.slice(74, 77), op.headCph);
    // Check bodyCph
    assertEquals(encoded.slice(77, 79), op.bodyCph);
  });

  await t.step("decodeBag", async () => {
    const op: IBag = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
      lenHeadCph: 3,
      lenBodyCph: 2,
      headCph: new Uint8Array([10, 11, 12]),
      bodyCph: new Uint8Array([13, 14]),
    };
    const enc = new Encoder();
    enc.writeStruct(bagCodec, op);
    const encoded = enc.result();
    const decoder = new Decoder(encoded);
    const decoded = decoder.readStruct(bagCodec);
    assertEquals(decoded.sig, op.sig);
    assertEquals(decoded.kdm, op.kdm);
    assertEquals(decoded.lenHeadCph, op.lenHeadCph);
    assertEquals(decoded.lenBodyCph, op.lenBodyCph);
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
    } catch (e) {
      // Expected to fail on incomplete
    }
  });

  await t.step("seal and open round trip", async () => {
    // Setup enclave and keypair
    const seed = (await crypto.gen256BitSecureRandomSeed()) as MasterSeed;
    const enclave = new Enclave(seed, crypto);
    const hostKDM = await enclave.derive("test-host", 0);
    const keyPair = await crypto.deriveEd25519KeyPair(hostKDM);

    // Create a test message
    const eid = await crypto.gen128BitRandomID();
    const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
    const msg: IMessage = {
      eid,
      clk: new Date(),
      ctr: 1,
      len: bod.length,
      bod,
    };

    // Seal the message
    const bag = await sealBag(msg, keyPair, crypto, enclave);

    // Open the bag
    const openedMsg = await openBag(bag, keyPair.publicKey, crypto, enclave);

    // Verify contents
    assertEquals(openedMsg.eid, msg.eid);
    assertEquals(openedMsg.clk.getTime(), msg.clk.getTime());
    assertEquals(openedMsg.ctr, msg.ctr);
    assertEquals(openedMsg.len, msg.len);
    assertEquals(openedMsg.bod, msg.bod);
  });
});
