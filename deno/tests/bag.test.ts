import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { openBag, sealBag } from "../../shared/bag.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import { Status } from "../../shared/consts.ts";
import type {
  EntityID,
  HostSpecificKeyPair,
  IBag,
  IMessage,
  MasterSeed,
} from "../../shared/types.ts";
import { Enclave } from "../../shared/enclave.ts";
import libsodiumCrypto from "../src/crypto.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";

Deno.test("bag", async (t) => {
  const crypto = libsodiumCrypto;

  await t.step("encodeBag", async () => {
    const op: IBag = {
      sig: new Uint8Array(64).fill(0x77),
      kdm: new Uint8Array(8).fill(0x88),
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
    // Check headCph
    assertEquals(encoded.slice(73, 76), op.headCph);
    // Check lenBodyCph varint
    assertEquals(encoded[76], 2); // varint for 2
    // Check bodyCph
    assertEquals(encoded.slice(77, 79), op.bodyCph);
  });

  await t.step("decodeBag", async () => {
    const op: IBag = {
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
    } catch (e) {
      // Expected to fail on incomplete
    }
  });

  await t.step("seal and open round trip", async () => {
    // Setup enclave and keypair
    const seed = (await crypto.gen256BitSecureRandomSeed()) as MasterSeed;
    const enclave = new Enclave(seed, crypto);
    const hostKDM = await enclave.derive("test-host", 0);
    const keyPair = await crypto.deriveEd25519KeyPair(
      hostKDM,
    ) as HostSpecificKeyPair;

    // Create a test message
    const eid = await crypto.genRandomBytes(16) as EntityID;
    const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
    const msg: IMessage = {
      eid,
      clk: new Date(),
      off: 0,
      ctr: 1,
      len: bod.length,
      bod,
    };

    // Seal the message
    const bag = await sealBag(msg, keyPair, crypto, enclave);

    // Open the bag
    const [openedMsg, status] = await openBag(
      bag,
      keyPair.publicKey,
      crypto,
      enclave,
    );
    if (status === Status.Success) {
      // openedMsg is IMessageWithHash

      // Verify contents
      assertEquals(openedMsg!.eid, msg.eid);
      assertEquals(openedMsg!.clk.getTime(), msg.clk.getTime());
      assertEquals(openedMsg!.ctr, msg.ctr);
      assertEquals(openedMsg!.len, msg.len);
      assertEquals(openedMsg!.bod, msg.bod);
    } else {
      throw new Error(`Open bag failed with status ${status}`);
    }
  });
});
