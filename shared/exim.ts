import { kdmFor } from "./bag";
import { Encoder } from "./codec";
import { fileCodec } from "./codecs/file";
import { fileHeadCodec, IFileHead } from "./codecs/fileHead";
import { fileIndexItemCodec, IFileIndexItem } from "./codecs/fileIndexItem";
import { messageHeadCodec } from "./codecs/messageHead";
import { Status } from "./consts";
import { Enclave } from "./enclave";
import { IMessageHead } from "./message";
import { HostSpecificKeyPair, ICrypto } from "./types";
import { err, ok, ValStat } from "./valstat";

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

const fileExtension = 'dpl';

// TODO:
// - unit test it
// - implement decodeFile function and test that too
// - consume these from client
export async function encodeFile(
  keyLbl: string,
  keyIdx: number,
  msgs: Iterable<{ head: IMessageHead, body?: Uint8Array }>,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<ValStat<Uint8Array>> {
  const derivSeed = await enclave.derive(keyLbl, keyIdx);
  const keys = await crypto.deriveEd25519KeyPair(derivSeed) as HostSpecificKeyPair;

  const encIndex = new Encoder();
  const encBody = new Encoder();

  let num = 0;
  let offset = 0;
  for (const msg of msgs) {
    const encHead = new Encoder();
    const statHeadEnc = encHead.writeStruct(messageHeadCodec, msg.head);
    if (statHeadEnc !== Status.Success) return err(statHeadEnc);
    const headEnc = encHead.result();

    const kdm = await kdmFor(headEnc, keys, crypto);
    const key = await enclave.deriveFromKDM(kdm);
    const headCph = await crypto.encryptXSalsa20Poly1305Combined(headEnc, key);
    const bodyCph = msg.body
      ? await crypto.encryptXSalsa20Poly1305Combined(msg.body, key)
      : new Uint8Array(0);

    const item: IFileIndexItem = {
      kdm,
      lenHead: headCph.length,
      headCph,
      lenBody: bodyCph.length,
      offBody: bodyCph.length > 0 ? offset : undefined,
    }
    const statItem = encIndex.writeStruct(fileIndexItemCodec, item);
    if (statItem !== Status.Success) return err(statItem);

    if (msg.body) {
      encBody.writeBytes(bodyCph);
      offset += bodyCph.length;
    }
  }

  // TODO: do this in a zero-copy way.
  const bodyEnc = encBody.result();

  // Hash the INDEX for integrity.
  const indexEnc = encIndex.result();
  const hsh = await crypto.blake3(indexEnc);

  // Sign the hash to prove ownership.
  const sig = await crypto.signEd25519(hsh, keys.privateKey);

  const head: IFileHead = {
    lbl: keyLbl,
    idx: keyIdx,
    num,
    hsh,
    sig,
  }
  const encHead = new Encoder();
  const headEncStat = encHead.writeStruct(fileHeadCodec, head);
  if (headEncStat !== Status.Success) return err(headEncStat);
  const headEnc = encHead.result();

  const encFile = new Encoder();
  encFile.writeStruct(fileCodec, { head, indexEnc, bodyEnc });
  const fileEnc = encFile.result();

  return ok(fileEnc);
}

// Imports.
// "file-saver": "^2.0.5",
// "jszip": "^3.10.1",

// Legacy import/export code.
// async export(filename: string, extension = "dip") {
//   const ops = await this.store.listOps();

//   const zip = new JSZip();
//   for (const op of ops) {
//     zip.file(`${op.sha256}.op`, op.cipherOp);
//   }
//   const blob = await zip.generateAsync({
//     compression: "STORE",
//     type: "blob",
//   });
//   return saveAs(blob, `${filename}.${extension}`);
// }

// import = async (file: File) => {
//   if (!this.encKey) {
//     return;
//   }
//   const { encKey } = this;
//   const zip = await JSZip.loadAsync(file);
//   for (const opFileName of Object.keys(zip.files)) {
//     const hex = opFileName.split(".")[0];
//     const zipSha256 = htob(hex);
//     if (await this.store.hasOp(zipSha256)) {
//       continue;
//     }
//     const cipher = await zip.files[opFileName].async("uint8array");
//     const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
//       cipher,
//       encKey,
//     );
//     const op = decode(packed) as IOp;
//     const sha256 = await libsodiumCrypto.sha256Hash(cipher);
//     await this.stateManager.apply(op);
//     await this.store.storeOp(sha256, cipher);
//     this.emitXferUpdate();
//   }
// };
