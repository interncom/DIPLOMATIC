import { openBag, sealBag } from "../../shared/bag.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import type { HostSpecificKeyPair, IMessage } from "../../shared/types.ts";

import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/enclave.ts";
import type { MasterSeed } from "../../shared/types.ts";
import libsodiumCrypto from "../src/crypto.ts";

// Setup crypto and keypair
const crypto = libsodiumCrypto;
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);
const hostKDM = await enclave.derive("benchmark-host", 0);
const keyPair = (await libsodiumCrypto.deriveEd25519KeyPair(
  hostKDM,
)) as HostSpecificKeyPair;

function createBod(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = i % 256;
  }
  return arr;
}

async function fullyEncodeBag(op: IMessage): Promise<Uint8Array> {
  const [bag, stat] = await sealBag(op, keyPair, crypto, enclave);
  if (stat !== Status.Success) {
    throw new Error("sealing bag")
  }
  const enc = new Encoder();
  enc.writeStruct(bagCodec, bag);
  return enc.result();
}

async function bench(size: number, suffix: string) {
  const bod = size === 16
    ? new TextEncoder().encode("HELLO DIPLOMATIC")
    : createBod(size);
  const id = await crypto.genRandomBytes(8);
  const eidObj = { id, ts: new Date(0) };
  const [eid, statEid] = makeEID(eidObj);
  if (statEid !== Status.Success) {
    throw new Error("encoding EID");
  }
  const op: IMessage = {
    eid,
    off: 0,
    ctr: 1,
    len: bod.length,
    bod,
  };
  Deno.bench(`seal bag (${suffix})`, async () => {
    await fullyEncodeBag(op);
  });
  const bagEnc = await fullyEncodeBag(op);
  Deno.bench(`open bag (${suffix})`, async () => {
    const decoder = new Decoder(bagEnc);
    const [bag, stat] = decoder.readStruct(bagCodec);
    if (stat !== Status.Success) {
      throw new Error(`Error decoding bag: ${stat}`);
    }
    const [, openStat] = await openBag(bag, keyPair.publicKey, crypto, enclave);
    if (openStat !== Status.Success) {
      throw new Error(`Open bag failed: ${openStat}`);
    }
  });
}

// Run benchmarks for each size
await bench(16, "16b");
await bench(512, "512b");
await bench(1024, "1kb");
await bench(16 * 1024, "16kb");
await bench(128 * 1024, "128kb");
await bench(1024 * 1024, "1mb");
await bench(5 * 1024 * 1024, "5mb");
