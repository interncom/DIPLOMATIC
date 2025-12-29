import { assertEquals } from "https://deno.land/std/testing/asserts.ts";
import { genKDM, makeBag } from "../../shared/bag.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import type { IBag } from "../../shared/types.ts";
import { type IMessage } from "../../shared/message.ts";
import {
  type IMessageHead,
  messageHeadCodec,
} from "../../shared/codecs/messageHead.ts";
import { concat } from "../../shared/lib.ts";
import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed } from "../../shared/types.ts";
import { Enclave } from "../../shared/enclave.ts";

// Setup crypto and keypair
const crypto = libsodiumCrypto;
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);
const hostKDM = await enclave.derive("benchmark-host", 0);
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(hostKDM);

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
  const hsh = op.bod && op.len > 0 ? await crypto.blake3(op.bod) : undefined;
  const headStruct: IMessageHead = {
    eid: op.eid,
    clk: op.clk,
    ctr: op.ctr,
    len: op.len,
    hsh,
  };
  const encHeader = new Encoder();
  messageHeadCodec.encode(encHeader, headStruct);
  const msgHead = encHeader.result();
  const kdm = await genKDM(crypto);
  const encKey = await enclave.deriveFromKDM(kdm);
  const headCph = await crypto.encryptXSalsa20Poly1305Combined(msgHead, encKey);
  if (!op.bod) {
    throw new Error("ahhh!");
  }
  const bodyCph = await crypto.encryptXSalsa20Poly1305Combined(op.bod, encKey);
  const bag = await makeBag(keyPair, headCph, bodyCph, kdm, crypto);
  const enc = new Encoder();
  enc.writeStruct(bagCodec, bag);
  return enc.result();
}

Deno.bench("full encode op", async (b) => {
  await fullyEncodeBag(op);
});

const bag = await fullyEncodeBag(op);

Deno.bench("full decode op", async (b) => {
  const decoder = new Decoder(bag);
  const decodedEnv: IBag = decoder.readStruct(bagCodec);
  const kdm = decodedEnv.kdm;
  const encKey = await enclave.deriveFromKDM(kdm);
  const decryptedHead = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.headCph,
    encKey,
  );
  const decryptedBody = await crypto.decryptXSalsa20Poly1305Combined(
    decodedEnv.bodyCph,
    encKey,
  );
  const decryptedMsg = concat(decryptedHead, decryptedBody);
  const dec = new Decoder(decryptedMsg);
  const msgHead = messageHeadCodec.decode(dec);
  const decodedBod = msgHead.len > 0 ? dec.readBytes(msgHead.len) : undefined;

  // Verify the body
  const decodedBody = new TextDecoder().decode(decodedBod);
  assertEquals(decodedBody, "HELLO DIPLOMATIC");
});
