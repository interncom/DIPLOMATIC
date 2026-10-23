// exim is short for Export/Import.
// This is where we define export file format.

import { bytesEqual } from "../binary.ts";
import { Decoder, Encoder } from "../codec.ts";
import { fileCodec } from "../codecs/file.ts";
import { fileHeadCodec, fileHeadPreimage } from "../codecs/fileHead.ts";
import {
  fileIndexItemCodec,
  type IFileIndexItem,
} from "../codecs/fileIndexItem.ts";
import { type IFileRealm } from "../codecs/fileRealm.ts";
import { type IKDM, kdmEq } from "../codecs/kdm.ts";
import { messageHeadCodec } from "../codecs/messageHead.ts";
import { hashBytes, Status } from "../consts.ts";
import { ICrypto, IMessageHead } from "../types.ts";
import { err, ok, ValStat } from "../valstat.ts";
import { BagManager } from "./bagman.ts";
import { nullKDM, type PDK } from "./derivation.ts";
import { Enclave } from "./enclave.ts";
import { bagmanForExport } from "./export.ts";

/* File format

HEADER
- 32-byte nonce (KDM of the file key)
- realm count, then that many records:
  - realm KDM
  - bag count (at least 1)
  - blake3 of that realm's head section
- blake3 of the nonce, then those records
- Ed25519 signature of that hash

The file key is an Export PDK of the master, keyed by the nonce.
Each realm key is a RealmKey PDK of the file key, keyed by that realm's
KDM. The bag cipher is the Cipher PDK of that realm key. The file is
signed by the null-KDM Identity PDK of the file key.

The file hash does not cover the chunks. Each realm's head-section hash,
inside the signed header, does. The directory is in the clear. Later it
can be encrypted under the file key. The nonce stays first.

CHUNKS, one per realm, in directory order
- head section: bag kdm, headCph, body length
- that realm's body ciphertexts, in head order
*/

// One message in an export file.
export interface IExportMsg {
  head: IMessageHead;
  body?: Uint8Array;
}

// Messages sealed under one realm KDM.
export interface IExportRealm {
  realm: IKDM;
  msgs: IExportMsg[];
}

// deno-lint-ignore no-namespace
export namespace Exim {
  export const defaultFileExtension = "dpl";

  // Reads the file-key nonce from an export header.
  export function exportNonce(file: Uint8Array): ValStat<Uint8Array> {
    const [head, st] = fileHeadCodec.decode(new Decoder(file));
    if (st !== Status.Success) return err(st);
    return ok(head.nonce);
  }

  // Seals realms under one export file key. The nonce is written in the header.
  // Does not wipe `key`.
  export async function sealExport(
    realms: Iterable<IExportRealm>,
    crypto: ICrypto,
    key: PDK["Export"],
    nonce: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    return encodeFile(realms, crypto, key, nonce);
  }

  // Seals realms under a fresh file key from `enclave`. Wipes that key before return.
  export async function exportFile(
    enclave: Enclave,
    crypto: ICrypto,
    realms: Iterable<IExportRealm>,
  ): Promise<ValStat<Uint8Array>> {
    const nonce = await crypto.genRandomBytes(hashBytes);
    const [key, kst] = await enclave.exportKey(nonce);
    if (kst !== Status.Success) return err(kst);
    try {
      return await encodeFile(realms, crypto, key, nonce);
    } finally {
      key.fill(0);
    }
  }

  // Encodes realms into a signed, encrypted diplomatic export file.
  // Does not wipe `key`. An empty `msgs` list is rejected.
  export async function encodeFile(
    realms: Iterable<IExportRealm>,
    crypto: ICrypto,
    key: PDK["Export"],
    nonce: Uint8Array,
  ): Promise<ValStat<Uint8Array>> {
    if (nonce.byteLength !== hashBytes) return err(Status.InvalidParam);
    const mgrs = realmBagMgrs(key);
    const [signer, sst0] = await mgrs(nullKDM);
    if (sst0 !== Status.Success) return err(sst0);
    const enc = new Encoder();
    const dir: IFileRealm[] = [];

    for (const part of realms) {
      if (part.msgs.length < 1) return err(Status.InvalidMessage);
      const [bagMgr, bst] = await mgrs(part.realm);
      if (bst !== Status.Success) return err(bst);
      const [heads, cst] = await sealChunk(enc, part, bagMgr);
      if (cst !== Status.Success) return err(cst);
      const chunkHsh = await crypto.blake3(heads);
      dir.push({ realm: part.realm, num: part.msgs.length, hsh: chunkHsh });
    }

    const [pre, pst] = fileHeadPreimage(nonce, dir);
    if (pst !== Status.Success) return err(pst);
    const hsh = await crypto.blake3(pre);
    const [sig, sst] = await signer.sign(hsh);
    if (sst !== Status.Success) return err(sst);

    const encHead = new Encoder();
    const stHead = encHead.writeStruct(fileHeadCodec, {
      nonce,
      realms: dir,
      hsh,
      sig,
    });
    if (stHead !== Status.Success) return err(stHead);
    // Chunks are already in `enc`. The header is small, so it can go in front.
    enc.prependBytes(encHead.result());
    return ok(enc.result());
  }

  // Decrypts and verifies an export file into realms. Does not wipe `key`.
  export async function decodeFile(
    file: Uint8Array,
    crypto: ICrypto,
    key: PDK["Export"],
  ): Promise<ValStat<IExportRealm[]>> {
    const [fileStruct, statDecode] = fileCodec.decode(new Decoder(file));
    if (statDecode !== Status.Success) return err(statDecode);
    const { head, chunks } = fileStruct;
    const mgrs = realmBagMgrs(key);
    const [signer, sst] = await mgrs(nullKDM);
    if (sst !== Status.Success) return err(sst);

    let verifyKey: CryptoKey;
    try {
      verifyKey = await crypto.importVerifyKey(signer.publicKey);
    } catch {
      return err(Status.CryptoError);
    }
    const sigValid = await crypto.checkSigEd25519(
      head.sig,
      head.hsh,
      verifyKey,
    );
    if (!sigValid) return err(Status.InvalidSignature);

    const [pre, pst] = fileHeadPreimage(head.nonce, head.realms);
    if (pst !== Status.Success) return err(pst);
    const computedHsh = await crypto.blake3(pre);
    if (!bytesEqual(computedHsh, head.hsh)) return err(Status.HashMismatch);

    // Authenticate the directory before reading counts out of it.
    const dec = new Decoder(chunks);
    const realms: IExportRealm[] = [];
    for (const row of head.realms) {
      const [bagMgr, bst] = await mgrs(row.realm);
      if (bst !== Status.Success) return err(bst);
      const [msgs, mst] = await openChunk(dec, chunks, row, crypto, bagMgr);
      if (mst !== Status.Success) return err(mst);
      realms.push({ realm: row.realm, msgs });
    }
    if (!dec.done()) return err(Status.InvalidMessage);
    return ok(realms);
  }

  // Re-encodes a file under `keyOut`. Does not wipe either key.
  export async function migrateFile(
    file: Uint8Array,
    crypto: ICrypto,
    keyIn: PDK["Export"],
    keyOut: PDK["Export"],
    nonce: Uint8Array,
    transform: (
      realms: Iterable<IExportRealm>,
    ) => Iterable<IExportRealm> | Promise<Iterable<IExportRealm>>,
  ): Promise<ValStat<Uint8Array>> {
    const [realms, stDec] = await decodeFile(file, crypto, keyIn);
    if (stDec !== Status.Success) return err(stDec);
    const mapped = await transform(realms);
    return encodeFile(mapped, crypto, keyOut, nonce);
  }
}

// Resolves one bag manager per realm KDM. Does not wipe `key`.
function realmBagMgrs(
  key: PDK["Export"],
): (realm: IKDM) => Promise<ValStat<BagManager>> {
  const cache: { realm: IKDM; bagMgr: BagManager }[] = [];
  return async (realm) => {
    for (const row of cache) {
      if (kdmEq(row.realm, realm)) return ok(row.bagMgr);
    }
    const [bagMgr, st] = await bagmanForExport(key, realm);
    if (st !== Status.Success) return err(st);
    cache.push({ realm, bagMgr });
    return ok(bagMgr);
  };
}

// XSalsa20-Poly1305 combined: 24-byte nonce and 16-byte tag.
const boxOver = 24 + 16;

// Ciphertext length of a message body. Zero when the head section omits it.
function boxedLen(msg: IExportMsg): number {
  const body = msg.body;
  if (body === undefined || msg.head.len <= 0 || msg.head.hsh === undefined) {
    return 0;
  }
  return body.length + boxOver;
}

// Writes one realm into `enc`: head section, then each body ciphertext.
// Returns the head section. Bodies are written once and not buffered together.
async function sealChunk(
  enc: Encoder,
  part: IExportRealm,
  bagMgr: BagManager,
): Promise<ValStat<Uint8Array>> {
  if (part.msgs.length < 1) return err(Status.InvalidMessage);
  const encHeads = new Encoder();
  const kdms: Uint8Array[] = [];
  for (const msg of part.msgs) {
    const encHead = new Encoder();
    const stHead = encHead.writeStruct(messageHeadCodec, msg.head);
    if (stHead !== Status.Success) return err(stHead);
    const headEnc = encHead.result();
    const [kdm, kst] = await bagMgr.bagKDM(headEnc);
    if (kst !== Status.Success) return err(kst);
    const [headCph, hst] = await bagMgr.encrypt(kdm, headEnc);
    if (hst !== Status.Success) return err(hst);
    const stItem = encHeads.writeStruct(fileIndexItemCodec, {
      kdm,
      headCph,
      lenBody: boxedLen(msg),
    });
    if (stItem !== Status.Success) return err(stItem);
    kdms.push(kdm);
  }
  const heads = encHeads.result();
  enc.writeBytes(heads);
  for (let i = 0; i < part.msgs.length; i++) {
    const msg = part.msgs[i];
    const kdm = kdms[i];
    if (msg === undefined || kdm === undefined) {
      return err(Status.InternalError);
    }
    const body = msg.body;
    if (
      body === undefined || msg.head.len <= 0 || msg.head.hsh === undefined
    ) continue;
    const [cph, cst] = await bagMgr.encrypt(kdm, body);
    if (cst !== Status.Success) return err(cst);
    enc.writeBytes(cph);
  }
  return ok(heads);
}

// Opens one realm chunk. The head-section hash is checked before the bodies.
async function openChunk(
  dec: Decoder,
  chunks: Uint8Array,
  row: IFileRealm,
  crypto: ICrypto,
  bagMgr: BagManager,
): Promise<ValStat<IExportMsg[]>> {
  const start = dec.consumed();
  const items: IFileIndexItem[] = [];
  for (let i = 0; i < row.num; i++) {
    const [item, ist] = dec.readStruct(fileIndexItemCodec);
    if (ist !== Status.Success) return err(ist);
    items.push(item);
  }
  const got = await crypto.blake3(chunks.subarray(start, dec.consumed()));
  if (!bytesEqual(got, row.hsh)) return err(Status.HashMismatch);

  const msgs: IExportMsg[] = [];
  for (const item of items) {
    const [headEnc, dst] = await bagMgr.decrypt(item.kdm, item.headCph);
    if (dst !== Status.Success) return err(dst);
    const [msgHead, headStatus] = messageHeadCodec.decode(
      new Decoder(headEnc),
    );
    if (headStatus !== Status.Success) return err(headStatus);

    if (item.lenBody < 0) return err(Status.InvalidMessage);
    if (item.lenBody === 0) {
      msgs.push({ head: msgHead });
      continue;
    }
    if (msgHead.hsh === undefined) return err(Status.InvalidMessage);
    const [cph, cst] = dec.readBytes(item.lenBody);
    if (cst !== Status.Success) return err(cst);
    const [bod, bdst] = await bagMgr.decrypt(item.kdm, cph);
    if (bdst !== Status.Success) return err(bdst);
    const hashBody = await crypto.blake3(bod);
    if (!bytesEqual(hashBody, msgHead.hsh)) return err(Status.HashMismatch);
    msgs.push({ head: msgHead, body: bod });
  }
  return ok(msgs);
}
