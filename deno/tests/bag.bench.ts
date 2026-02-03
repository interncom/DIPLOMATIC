import { openBag, sealBag } from "../../shared/bag.ts";
import { Decoder, Encoder } from "../../shared/codec.ts";
import { bagCodec } from "../../shared/codecs/bag.ts";
import type { IMessage, HostSpecificKeyPair } from "../../shared/types.ts";

import libsodiumCrypto from "../src/crypto.ts";
import type { MasterSeed } from "../../shared/types.ts";
import { Enclave } from "../../shared/enclave.ts";
import { Status } from "../../shared/consts.ts";

// Setup crypto and keypair
const crypto = libsodiumCrypto;
const seed = (await libsodiumCrypto.gen256BitSecureRandomSeed()) as MasterSeed;
const enclave = new Enclave(seed, libsodiumCrypto);
const hostKDM = await enclave.derive("benchmark-host", 0);
const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(
  hostKDM,
) as HostSpecificKeyPair;

function createBod(size: number): Uint8Array {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = i % 256;
  }
  return arr;
}

async function fullyEncodeBag(op: IMessage): Promise<Uint8Array> {
  const bag = await sealBag(op, keyPair, crypto, enclave);
  const enc = new Encoder();
  enc.writeStruct(bagCodec, bag);
  return enc.result();
}

async function bench(size: number, suffix: string) {
  const bod = size === 16
    ? new TextEncoder().encode("HELLO DIPLOMATIC")
    : createBod(size);
  const eid = await crypto.gen128BitRandomID();
  const op: IMessage = {
    eid,
    clk: new Date(),
    off: 0,
    ctr: 1,
    len: bod.length,
    bod,
  };
  Deno.bench(`seal bag (${suffix})`, async (b) => {
    await fullyEncodeBag(op);
  });
  const bagEnc = await fullyEncodeBag(op);
  Deno.bench(`open bag (${suffix})`, async (b) => {
    const decoder = new Decoder(bagEnc);
    const [bag, stat] = decoder.readStruct(bagCodec);
    if (stat !== Status.Success) {
      throw new Error(`Error decoding bag: ${stat}`);
    }
    const [, openStat] = await openBag(
      bag,
      keyPair.publicKey,
      crypto,
      enclave,
    );
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
