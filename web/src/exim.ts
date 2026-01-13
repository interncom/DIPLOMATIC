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
