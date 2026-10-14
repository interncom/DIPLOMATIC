// exim is short for Export/Import.
// This is where we define export file format.

import { bytesEqual } from "./binary.ts";
import { Decoder, Encoder } from "./codec.ts";
import { fileCodec } from "./codecs/file.ts";
import { IFileHead } from "./codecs/fileHead.ts";
import { fileIndexItemCodec, IFileIndexItem } from "./codecs/fileIndexItem.ts";
import { messageHeadCodec } from "./codecs/messageHead.ts";
import { Status } from "./consts.ts";
import { BagManager } from "./crypto/bagman.ts";
import { ICrypto, IMessageHead } from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

/* File format

Diplomatic files are a custom binary format designed to efficiently store bags.
Bags are encrypted messages. Like with host-stored bags, the encryption key is
derived from a string label and numerical index. Unlike with host-stored bags,
in file-stored bags, the key label and index are stored alongside the bags, to
minimize risk of lost keys.

File contains sections:

HEADER
- key label
- key index
- bag count
- blake3 hash of INDEX section

INDEX
- concatenated sequence of:
  - head len
  - headCph
  - body len
  - body offset

BAGS
- concatenated sequence of:
  - bodyCph

INDEX should be ordered last-first, to apply the latest data first.
This allows obsolete messages to be skipped before application.

The INDEX section allows parallelization for bag loading.

Should have a checksum of some sort in the HEADER, e.g. hash of concatenated bag hashes in the INDEX section.
*/

// deno-lint-ignore no-namespace
export namespace Exim {
  export const defaultFileExtension = "dpl";

  // Encodes msgs into a signed, encrypted diplomatic export file.
  export async function encodeFile(
    msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }>,
    crypto: ICrypto,
    bagMgr: BagManager,
  ): Promise<ValStat<Uint8Array>> {
    const id = bagMgr.idKDM;
    const encIndex = new Encoder();
    const encBody = new Encoder();

    let num = 0;
    let offset = 0;
    for (const msg of msgs) {
      const encHead = new Encoder();
      const statHeadEnc = encHead.writeStruct(messageHeadCodec, msg.head);
      if (statHeadEnc !== Status.Success) return err(statHeadEnc);
      const headEnc = encHead.result();

      const [kdm, kst] = await bagMgr.bagKDM(headEnc);
      if (kst !== Status.Success) return err(kst);
      const [headCph, hst] = await bagMgr.encrypt(kdm, headEnc);
      if (hst !== Status.Success) return err(hst);
      let bodyCph: Uint8Array = new Uint8Array(0);
      if (msg.body) {
        const [cph, bst] = await bagMgr.encrypt(kdm, msg.body);
        if (bst !== Status.Success) return err(bst);
        bodyCph = cph;
      }

      const lenBody = msg.head.len > 0 && msg.head.hsh !== undefined
        ? bodyCph.length
        : 0;
      const item: IFileIndexItem = {
        kdm,
        headCph,
        lenBody,
        offBody: lenBody > 0 ? offset : undefined,
      };
      const statItem = encIndex.writeStruct(fileIndexItemCodec, item);
      if (statItem !== Status.Success) return err(statItem);

      if (msg.body) {
        encBody.writeBytes(bodyCph);
        offset += bodyCph.length;
      }

      num++;
    }

    // TODO: do this in a zero-copy way.
    const bodyEnc = encBody.result();

    // Hash the INDEX for integrity.
    const indexEnc = encIndex.result();
    const hsh = await crypto.blake3(indexEnc);

    // Sign the hash to prove ownership. The private key stays in the manager.
    const [sig, sst] = await bagMgr.sign(hsh);
    if (sst !== Status.Success) return err(sst);

    const head: IFileHead = {
      lbl: id.label,
      idx: id.index,
      num,
      hsh,
      sig,
    };

    const encFile = new Encoder();
    encFile.writeStruct(fileCodec, { head, indexEnc, bodyEnc });
    const fileEnc = encFile.result();

    return ok(fileEnc);
  }

  // Decrypts and verifies a diplomatic export file into msgs.
  // The file head label and index must match `bagMgr`.
  export async function decodeFile(
    file: Uint8Array,
    crypto: ICrypto,
    bagMgr: BagManager,
  ): Promise<ValStat<{ head: IMessageHead; body?: Uint8Array }[]>> {
    const [fileStruct, statDecode] = fileCodec.decode(new Decoder(file));
    if (statDecode !== Status.Success) return err(statDecode);
    const { head, indexEnc, bodyEnc } = fileStruct;
    const id = bagMgr.idKDM;
    if (head.lbl !== id.label || head.idx !== id.index) {
      return err(Status.InvalidParam);
    }

    // Check that hash signature is valid.
    let verifyKey: CryptoKey;
    try {
      verifyKey = await crypto.importVerifyKey(bagMgr.publicKey);
    } catch {
      return err(Status.CryptoError);
    }
    const sigValid = await crypto.checkSigEd25519(
      head.sig,
      head.hsh,
      verifyKey,
    );
    if (!sigValid) return err(Status.InvalidSignature);

    // Check that hash matches head contents (header data validates body data).
    const computedHsh = await crypto.blake3(indexEnc);
    if (!bytesEqual(computedHsh, head.hsh)) return err(Status.HashMismatch);

    const decoder = new Decoder(indexEnc);
    const items: IFileIndexItem[] = [];
    for (let i = 0; i < head.num; i++) {
      const [item, itemStatus] = decoder.readStruct(fileIndexItemCodec);
      if (itemStatus !== Status.Success) return err(itemStatus);
      // TODO: per-item failure codes. Allow partial import.
      items.push(item);
    }

    if (items.length !== head.num) return err(Status.InvalidMessage);

    const messages: { head: IMessageHead; body?: Uint8Array }[] = [];
    for (const item of items) {
      const [headEnc, dst] = await bagMgr.decrypt(item.kdm, item.headCph);
      if (dst !== Status.Success) return err(dst);
      const [msgHead, headStatus] = messageHeadCodec.decode(
        new Decoder(headEnc),
      );
      if (headStatus !== Status.Success) return err(headStatus);

      let itemBodyEnc: Uint8Array | undefined;
      if (item.lenBody > 0 && item.offBody !== undefined) {
        if (msgHead.hsh === undefined) return err(Status.InvalidMessage);
        const itemBodyCph = bodyEnc.slice(
          item.offBody,
          item.offBody + item.lenBody,
        );
        const [bod, bdst] = await bagMgr.decrypt(item.kdm, itemBodyCph);
        if (bdst !== Status.Success) return err(bdst);
        itemBodyEnc = bod;
        const hashItemBody = await crypto.blake3(itemBodyEnc);
        if (!bytesEqual(hashItemBody, msgHead.hsh)) {
          return err(Status.HashMismatch);
        }
        // TODO: per-item failure codes. Allow partial import.
      }

      messages.push({ head: msgHead, body: itemBodyEnc });
    }

    return ok(messages);
  }

  // Re-encodes a file from bagMgrIn to bagMgrOut, mapping msgs through transform.
  export async function migrateFile(
    file: Uint8Array,
    crypto: ICrypto,
    bagMgrIn: BagManager,
    bagMgrOut: BagManager,
    transform: (
      msgs: Iterable<{ head: IMessageHead; body?: Uint8Array }>,
    ) =>
      | Iterable<{ head: IMessageHead; body?: Uint8Array }>
      | Promise<Iterable<{ head: IMessageHead; body?: Uint8Array }>>,
  ): Promise<ValStat<Uint8Array>> {
    const [msgs, stDec] = await decodeFile(file, crypto, bagMgrIn);
    if (stDec !== Status.Success) return err(stDec);
    const mapped = await transform(msgs);
    return encodeFile(mapped, crypto, bagMgrOut);
  }
}
