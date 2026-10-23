import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder } from "../../shared/codec.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { hashBytes, Status } from "../../shared/consts.ts";
import { nullKDM, type PDK } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import {
  Exim,
  type IExportMsg,
  type IExportRealm,
} from "../../shared/crypto/exim.ts";
import { genDeleteHead, genUpsertHead } from "../../shared/message.ts";
import type {
  DerivationSeed,
  EntityID,
  Hash,
  ICrypto,
  IMessageHead,
  KeyPair,
  PrivateKey,
  PublicKey,
} from "../../shared/types.ts";
import { type ValStat } from "../../shared/valstat.ts";

// Mock implementations for deterministic testing
class MockCrypto implements ICrypto {
  async genRandomBytes(bytes: number): Promise<Uint8Array> {
    return new Uint8Array(bytes).fill(0xAA);
  }

  async gen256BitSecureRandomSeed(): Promise<Uint8Array> {
    return new Uint8Array(32).fill(0xBB);
  }

  async encryptXSalsa20Poly1305Combined(
    plaintext: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    // Return a mock ciphertext: prefix with 0xFF and append key
    const prefix = new Uint8Array([0xFF]);
    return new Uint8Array([...prefix, ...plaintext, ...key.slice(0, 8)]);
  }

  async decryptXSalsa20Poly1305Combined(
    headerAndCipher: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array> {
    if (headerAndCipher[0] !== 0xFF) throw new Error("Invalid mock ciphertext");
    const keyPart = headerAndCipher.slice(-8);
    if (!keyPart.every((v, i) => v === key[i])) throw new Error("Key mismatch");
    return headerAndCipher.slice(1, -8);
  }

  async deriveEd25519KeyPair(
    _derivationSeed: DerivationSeed,
  ): Promise<KeyPair> {
    return {
      keyType: "private",
      privateKey: new Uint8Array(32).fill(0xCC),
      publicKey: new Uint8Array(32).fill(0xDD),
    } as KeyPair;
  }

  async signEd25519(
    _message: Uint8Array | string,
    _secKey: PrivateKey,
  ): Promise<Uint8Array> {
    return new Uint8Array(64).fill(0xEE);
  }

  async blake3(_data: Uint8Array): Promise<Hash> {
    return new Uint8Array(32).fill(0x99) as Hash;
  }

  async importVerifyKey(pubKey: PublicKey): Promise<CryptoKey> {
    return await crypto.subtle.importKey(
      "raw",
      pubKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  }

  async checkSigEd25519(
    _sig: Uint8Array,
    _message: Uint8Array | string,
    _verifyKey: CryptoKey,
  ): Promise<boolean> {
    return true;
  }
}

const testSeed = new Uint8Array(32).fill(0x11);
const nonce = new Uint8Array(hashBytes).fill(0x42);
const nonceOut = new Uint8Array(hashBytes).fill(0x43);

function withRealm(
  msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }>,
): IExportRealm[] {
  const list: IExportMsg[] = [];
  for (const msg of msgs) list.push({ head: msg.head, body: msg.body });
  if (list.length === 0) return [];
  return [{ realm: nullKDM, msgs: list }];
}

function bags(realms: readonly IExportRealm[]): IExportMsg[] {
  const out: IExportMsg[] = [];
  for (const part of realms) {
    for (const msg of part.msgs) out.push(msg);
  }
  return out;
}

async function fileKey(enclave: Enclave, n = nonce): Promise<PDK["Export"]> {
  const [key, st] = await enclave.exportKey(n);
  if (st !== Status.Success || key === undefined) {
    throw new Error(`exportKey ${st}`);
  }
  return key;
}

async function seal(
  enclave: Enclave,
  crypto: ICrypto,
  msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }>,
): Promise<ValStat<Uint8Array>> {
  const key = await fileKey(enclave);
  try {
    return await Exim.encodeFile(withRealm(msgs), crypto, key, nonce);
  } finally {
    key.fill(0);
  }
}

async function open(
  enclave: Enclave,
  crypto: ICrypto,
  file: Uint8Array,
): Promise<ValStat<IExportRealm[]>> {
  const key = await fileKey(enclave);
  try {
    return await Exim.decodeFile(file, crypto, key);
  } finally {
    key.fill(0);
  }
}

Deno.test("Exim.encodeFile", async (t) => {
  const crypto = new MockCrypto();
  const [enclave, est] = Enclave.fromBytes(testSeed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }

  await t.step("empty messages", async () => {
    const msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }> = [];
    const [fileData, statFile] = await seal(enclave, crypto, msgs);
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;
    assertEquals(fileData.length > 0, true);

    // Decode and verify structure
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(bytesEqual(file.head.nonce, nonce), true);
    assertEquals(file.head.realms.length, 0);
    assertEquals(file.chunks.length, 0);
  });

  await t.step("single message without body", async () => {
    const now = new Date();
    const id = await crypto.genRandomBytes(8);

    const eidObj = { id: id as EntityID, ts: now };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }

    const [head, statHead] = await genDeleteHead({
      now,
      eid,
      ctr: 1,
      crypto,
    });
    if (statHead !== Status.Success) {
      assertEquals(statHead, Status.Success);
      return;
    }
    const msgs = [{ head }];
    const [fileData, statFile] = await seal(enclave, crypto, msgs);
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(bytesEqual(file.head.nonce, nonce), true);
    assertEquals(file.head.realms.length, 1);
    assertEquals(file.head.realms[0]?.num, 1);
    assertEquals(file.chunks.length > 0, true);
  });

  await t.step("single message with body", async () => {
    const now = new Date();
    const id = await crypto.genRandomBytes(8);

    const eidObj = { id: id as EntityID, ts: now };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }

    const body = new TextEncoder().encode("test body");
    const [head, statHead] = await genUpsertHead({
      now,
      eid,
      ctr: 1,
      bod: body,
      crypto,
    });
    if (statHead !== Status.Success) {
      assertEquals(statHead, Status.Success);
      return;
    }
    const msgs = [{ head, body }];
    const [fileData, statFile] = await seal(enclave, crypto, msgs);
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(bytesEqual(file.head.nonce, nonce), true);
    assertEquals(file.head.realms.length, 1);
    assertEquals(file.head.realms[0]?.num, 1);
    assertEquals(file.chunks.length > 0, true);
  });

  await t.step("multiple messages", async () => {
    const msgs: Array<{ head: IMessageHead; body?: Uint8Array }> = [];
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      const id = await crypto.genRandomBytes(8);

      const eidObj = { id, ts: now };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        assertEquals(statEid, Status.Success);
        return;
      }

      const body = i % 2 === 0
        ? new TextEncoder().encode(`body ${i}`)
        : undefined;
      const [head, statHead] = await genUpsertHead({
        now,
        eid,
        ctr: i,
        bod: body || new Uint8Array(0),
        crypto,
      });
      if (statHead !== Status.Success) {
        assertEquals(statHead, Status.Success);
        return;
      }
      msgs.push({ head, body });
    }
    const [fileData, statFile] = await seal(enclave, crypto, msgs);
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(bytesEqual(file.head.nonce, nonce), true);
    assertEquals(file.head.realms.length, 1);
    assertEquals(file.head.realms[0]?.num, 3);
    assertEquals(file.chunks.length > 0, true);
  });
});

Deno.test("Exim.decodeFile", async (t) => {
  const crypto = new MockCrypto();
  const [enclave, est] = Enclave.fromBytes(testSeed);
  if (est !== Status.Success || enclave === undefined) {
    throw new Error(`enclave ${est}`);
  }

  await t.step("round-trip empty messages", async () => {
    const [file, statEnc] = await seal(enclave, crypto, []);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [realms, statDec] = await open(enclave, crypto, file);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

    assertEquals(realms.length, 0);
    assertEquals(bags(realms).length, 0);
  });

  await t.step("round-trip single message without body", async () => {
    const now = new Date();
    const id = await crypto.genRandomBytes(8);

    const eidObj = { id, ts: now };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }

    const [head, statHead] = await genDeleteHead({ now, eid, ctr: 1, crypto });
    if (statHead !== Status.Success) {
      assertEquals(statHead, Status.Success);
      return;
    }
    const msgs = [{ head }];
    const [file, statEnc] = await seal(enclave, crypto, msgs);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [realms, statDec] = await open(enclave, crypto, file);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

    const msgsDecoded = bags(realms);
    assertEquals(realms.length, 1);
    assertEquals(msgsDecoded.length, 1);
    const msgDecoded = msgsDecoded[0];
    assertEquals(msgDecoded.head.eid, head.eid);
    assertEquals(msgDecoded.body, undefined);
  });

  await t.step("round-trip single message with body", async () => {
    const now = new Date();
    const id = await crypto.genRandomBytes(8);

    const eidObj = { id, ts: now };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }

    const body = new TextEncoder().encode("test body");
    const [head, statHead] = await genUpsertHead({
      now,
      eid,
      ctr: 1,
      bod: body,
      crypto,
    });
    if (statHead !== Status.Success) {
      assertEquals(statHead, Status.Success);
      return;
    }
    const originalMsgs = [{ head, body }];
    const [fileData, statEnc] = await seal(enclave, crypto, originalMsgs);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [realms, statDec] = await open(enclave, crypto, fileData);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

    const msgsDecoded = bags(realms);
    assertEquals(realms.length, 1);
    assertEquals(msgsDecoded.length, 1);
    const msgDecoded = msgsDecoded[0];
    assertEquals(msgDecoded.head.eid, head.eid);
    assertEquals(msgDecoded.body, body);
  });

  await t.step("round-trip multiple messages", async () => {
    const msgs: Array<{ head: IMessageHead; body?: Uint8Array }> = [];
    for (let i = 0; i < 3; i++) {
      const now = new Date();
      const id = await crypto.genRandomBytes(8);

      const eidObj = { id, ts: now };
      const [eid, statEid] = makeEID(eidObj);
      if (statEid !== Status.Success) {
        assertEquals(statEid, Status.Success);
        return;
      }

      const body = i % 2 === 0
        ? new TextEncoder().encode(`body ${i}`)
        : undefined;
      const [head, statHead] = await genUpsertHead({
        now,
        eid,
        ctr: i,
        bod: body || new Uint8Array(0),
        crypto,
      });
      if (statHead !== Status.Success) {
        assertEquals(statHead, Status.Success);
        return;
      }
      msgs.push({ head, body });
    }
    const [file, statEnc] = await seal(enclave, crypto, msgs);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [realms, statDec] = await open(enclave, crypto, file);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

    const msgsDecoded = bags(realms);
    assertEquals(realms.length, 1);
    assertEquals(msgsDecoded.length, 3);
    for (let i = 0; i < 3; i++) {
      const msg = msgsDecoded[i];
      assertEquals(msg.head.eid, msgs[i].head.eid);
      if (msgs[2 - i].body) {
        assertEquals(msg.body, msgs[i].body);
      } else {
        assertEquals(msg.body, undefined);
      }
    }
  });
});

Deno.test("Exim.migrateFile", async (t) => {
  const crypto = new MockCrypto();
  const [enclaveIn, stIn] = Enclave.fromBytes(testSeed);
  if (stIn !== Status.Success || enclaveIn === undefined) {
    throw new Error(`enclaveIn ${stIn}`);
  }
  const [enclaveOut, stOut] = Enclave.fromBytes(new Uint8Array(32).fill(0x22));
  if (stOut !== Status.Success || enclaveOut === undefined) {
    throw new Error(`enclaveOut ${stOut}`);
  }

  await t.step("re-encrypts under a new enclave", async () => {
    const now = new Date();
    const id = await crypto.genRandomBytes(8);
    const [eid, statEid] = makeEID({ id, ts: now });
    if (statEid !== Status.Success) {
      assertEquals(statEid, Status.Success);
      return;
    }
    const body = new TextEncoder().encode("migrate me");
    const [head, statHead] = await genUpsertHead({
      now,
      eid,
      ctr: 1,
      bod: body,
      crypto,
    });
    if (statHead !== Status.Success) {
      assertEquals(statHead, Status.Success);
      return;
    }
    const keyIn = await fileKey(enclaveIn);
    const keyOut = await fileKey(enclaveOut, nonceOut);
    try {
      const [file, statEnc] = await Exim.encodeFile(
        withRealm([{ head, body }]),
        crypto,
        keyIn,
        nonce,
      );
      assertEquals(statEnc, Status.Success);
      if (statEnc !== Status.Success) return;

      const [migrated, stMig] = await Exim.migrateFile(
        file,
        crypto,
        keyIn,
        keyOut,
        nonceOut,
        (msgs) => msgs,
      );
      assertEquals(stMig, Status.Success);
      if (stMig !== Status.Success) return;

      const [outStruct, stOutFile] = fileCodec.decode(new Decoder(migrated));
      assertEquals(stOutFile, Status.Success);
      if (stOutFile !== Status.Success) return;
      assertEquals(bytesEqual(outStruct.head.nonce, nonceOut), true);

      const [realmsOut, stDecOut] = await Exim.decodeFile(
        migrated,
        crypto,
        keyOut,
      );
      assertEquals(stDecOut, Status.Success);
      if (stDecOut !== Status.Success) return;
      const msgsOut = bags(realmsOut);
      assertEquals(msgsOut.length, 1);
      assertEquals(msgsOut[0].head.eid, head.eid);
      assertEquals(msgsOut[0].body, body);

      const [, stDecIn] = await Exim.decodeFile(migrated, crypto, keyIn);
      assertEquals(stDecIn, Status.DecryptionError);
    } finally {
      keyIn.fill(0);
      keyOut.fill(0);
    }
  });

  await t.step("applies transform to plaintext msgs", async () => {
    const msgs: Array<{ head: IMessageHead; body?: Uint8Array }> = [];
    for (let i = 0; i < 2; i++) {
      const now = new Date();
      const id = await crypto.genRandomBytes(8);
      const [eid, statEid] = makeEID({ id, ts: now });
      if (statEid !== Status.Success) {
        assertEquals(statEid, Status.Success);
        return;
      }
      const body = new TextEncoder().encode(`body ${i}`);
      const [head, statHead] = await genUpsertHead({
        now,
        eid,
        ctr: i,
        bod: body,
        crypto,
      });
      if (statHead !== Status.Success) {
        assertEquals(statHead, Status.Success);
        return;
      }
      msgs.push({ head, body });
    }
    const keyIn = await fileKey(enclaveIn);
    const keyOut = await fileKey(enclaveOut, nonceOut);
    let msgsOut: IExportMsg[] | undefined;
    let stDec = Status.InternalError;
    try {
      const [file, statEnc] = await Exim.encodeFile(
        withRealm(msgs),
        crypto,
        keyIn,
        nonce,
      );
      assertEquals(statEnc, Status.Success);
      if (statEnc !== Status.Success) return;

      const [migrated, stMig] = await Exim.migrateFile(
        file,
        crypto,
        keyIn,
        keyOut,
        nonceOut,
        (inRealms) => {
          const [part] = inRealms;
          if (part === undefined) return [];
          const msg = part.msgs[0];
          if (msg === undefined) return [];
          return [{ realm: part.realm, msgs: [msg] }];
        },
      );
      assertEquals(stMig, Status.Success);
      if (stMig !== Status.Success) return;

      const [decoded, st] = await Exim.decodeFile(
        migrated,
        crypto,
        keyOut,
      );
      if (st === Status.Success) msgsOut = bags(decoded);
      stDec = st;
    } finally {
      keyIn.fill(0);
      keyOut.fill(0);
    }
    assertEquals(stDec, Status.Success);
    if (stDec !== Status.Success) return;
    assertEquals(msgsOut.length, 1);
    assertEquals(msgsOut[0].head.eid, msgs[0].head.eid);
    assertEquals(msgsOut[0].body, msgs[0].body);
  });
});
