import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { openBag, sealBag } from "../../shared/bag.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import type { HostSpecificKeyPair, IBag } from "../../shared/types.ts";
import { type IMessage } from "../../shared/message.ts";

import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed } from "../../shared/types.ts";
import { Enclave } from "../../shared/enclave.ts";

// Setup crypto and keypair
const crypto = libsodiumCrypto;
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);
const hostKDM = await enclave.derive("benchmark-host", 0);
const keyPair = await libsodiumCrypto.deriveSchnorrKeyPair(
  hostKDM,
) as HostSpecificKeyPair;

// Create the op containing "HELLO DIPLOMATIC"
const eid = await crypto.gen128BitRandomID();
const bod = new TextEncoder().encode("HELLO DIPLOMATIC");
const op: IMessage = {
  eid,
  clk: new Date(),
  ctr: 1,
  len: bod.length,
  bod,
};

async function fullyEncodeBag(op: IMessage): Promise<Uint8Array> {
  const bag = await sealBag(op, keyPair, crypto, enclave);
  const enc = new Encoder();
  enc.writeStruct(bagCodec, bag);
  return enc.result();
}

Deno.bench("seal bag", async (b) => {
  await fullyEncodeBag(op);
});

const bagEnc = await fullyEncodeBag(op);

Deno.bench("open bag", async (b) => {
  const decoder = new Decoder(bagEnc);
  const bag: IBag = decoder.readStruct(bagCodec);
  const openedMsg = await openBag(
    bag,
    keyPair.publicKey,
    crypto,
    enclave,
  );

  // Verify the body
  const decodedBody = new TextDecoder().decode(openedMsg.bod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");
});
