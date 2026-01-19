import { ValStat } from "./valstat";

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

File extension .dpl

Should have a checksum of some sort in the HEADER, e.g. hash of concatenated bag hashes in the INDEX section.
*/

// export async function exportFile(name: string): ValStat<Uint8Array> {
// }


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
