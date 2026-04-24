import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { Decoder } from "../../shared/codec.ts";
import { makeEID } from "../../shared/codecs/eid.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/enclave.ts";
import { decodeFile, encodeFile } from "../../shared/exim.ts";
import { genDeleteHead, genUpsertHead } from "../../shared/message.ts";
import type {
  DerivationSeed,
  EntityID,
  Hash,
  ICrypto,
  IMessageHead,
  KeyPair,
  MasterSeed,
  PrivateKey,
  PublicKey,
} from "../../shared/types.ts";

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

  async checkSigEd25519(
    _sig: Uint8Array,
    _message: Uint8Array | string,
    _pubKey: PublicKey,
  ): Promise<boolean> {
    return true;
  }
}

class MockEnclave extends Enclave {
  constructor() {
    super(new Uint8Array(32).fill(0x11) as MasterSeed, new MockCrypto());
  }

  override async derive(keyPath: string, idx = 0): Promise<DerivationSeed> {
    const data = new TextEncoder().encode(keyPath + idx.toString());
    return new Uint8Array(32).fill(data.length % 256) as DerivationSeed;
  }

  override async deriveFromKDM(kdm: Uint8Array): Promise<DerivationSeed> {
    return new Uint8Array(32).fill(kdm[0] || 0x22) as DerivationSeed;
  }
}

const lbl = "test-label";

Deno.test("encodeFile", async (t) => {
  const crypto = new MockCrypto();
  const enclave = new MockEnclave();

  await t.step("empty messages", async () => {
    const msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }> = [];
    const [fileData, statFile] = await encodeFile(
      "test-label",
      0,
      msgs,
      crypto,
      enclave,
    );
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;
    assertEquals(fileData.length > 0, true);

    // Decode and verify structure
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(file.head.lbl, "test-label");
    assertEquals(file.head.idx, 0);
    assertEquals(file.head.num, 0);
    assertEquals(file.indexEnc.length, 0);
    assertEquals(file.bodyEnc.length, 0);
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
    const [fileData, statFile] = await encodeFile(
      "test-label",
      0,
      msgs,
      crypto,
      enclave,
    );
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(file.head.lbl, "test-label");
    assertEquals(file.head.idx, 0);
    assertEquals(file.head.num, 1);
    assertEquals(file.indexEnc.length > 0, true);
    assertEquals(file.bodyEnc.length, 0);
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
    const [fileData, statFile] = await encodeFile(
      "test-label",
      0,
      msgs,
      crypto,
      enclave,
    );
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(file.head.lbl, "test-label");
    assertEquals(file.head.idx, 0);
    assertEquals(file.head.num, 1);
    assertEquals(file.indexEnc.length > 0, true);
    assertEquals(file.bodyEnc.length > 0, true);
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
    const [fileData, statFile] = await encodeFile(
      "test-label",
      1,
      msgs,
      crypto,
      enclave,
    );
    assertEquals(statFile, Status.Success);
    if (statFile !== Status.Success) return;

    // Decode and verify
    const dec = new Decoder(fileData);
    const [file, status] = dec.readStruct(fileCodec);
    assertEquals(status, Status.Success);
    if (status !== Status.Success) return;
    assertEquals(file.head.lbl, "test-label");
    assertEquals(file.head.idx, 1);
    assertEquals(file.head.num, 3);
    assertEquals(file.indexEnc.length > 0, true);
    assertEquals(file.bodyEnc.length > 0, true); // At least one message has body
  });
});

Deno.test("decodeFile", async (t) => {
  const crypto = new MockCrypto();
  const enclave = new MockEnclave();

  await t.step("round-trip empty messages", async () => {
    const [file, statEnc] = await encodeFile(lbl, 0, [], crypto, enclave);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [msgsDecoded, statDec] = await decodeFile(file, crypto, enclave);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

    assertEquals(msgsDecoded.length, 0);
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
    const [file, statEnc] = await encodeFile(lbl, 0, msgs, crypto, enclave);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [msgsDecoded, statDec] = await decodeFile(file, crypto, enclave);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

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
    const [fileData, statEnc] = await encodeFile(
      lbl,
      0,
      originalMsgs,
      crypto,
      enclave,
    );
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [msgsDecoded, statDec] = await decodeFile(fileData, crypto, enclave);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

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
    const [file, statEnc] = await encodeFile(lbl, 1, msgs, crypto, enclave);
    assertEquals(statEnc, Status.Success);
    if (statEnc !== Status.Success) return;

    const [msgsDecoded, statDec] = await decodeFile(file, crypto, enclave);
    assertEquals(statDec, Status.Success);
    if (statDec !== Status.Success) return;

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
