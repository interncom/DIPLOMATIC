import { decode, encode } from "@msgpack/msgpack";
import { bytesEqual } from "../../shared/binary.ts";
import { Decoder, ICodecStruct } from "../../shared/codec.ts";
import { eidCodec } from "../../shared/codecs/eid.ts";
import { fileCodec } from "../../shared/codecs/file.ts";
import { fileIndexItemCodec } from "../../shared/codecs/fileIndexItem.ts";
import { hshBytes, Status } from "../../shared/consts.ts";
import type { Enclave } from "../../shared/crypto/enclave.ts";
import type { EntityID, ICrypto, IMessageHead } from "../../shared/types.ts";
import { err, ok, type ValStat } from "../../shared/valstat.ts";

type Msg = { head: IMessageHead; body?: Uint8Array };

/** 0.19.x head: eid, off, ctr, len, hsh. No leading typ. */
export const v19MessageHeadCodec: ICodecStruct<IMessageHead> = {
  encode(enc, msg) {
    const s0 = enc.writeVarBytes(msg.eid);
    if (s0 !== Status.Success) return s0;
    const s1 = enc.writeVarInt(msg.off);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeVarInt(msg.ctr);
    if (s2 !== Status.Success) return s2;
    const s3 = enc.writeVarInt(msg.len);
    if (s3 !== Status.Success) return s3;
    if (msg.hsh) {
      enc.writeBytes(msg.hsh);
    }
    return Status.Success;
  },
  decode(dec) {
    const [eid, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    const decEid = new Decoder(eid);
    const [, statEid] = eidCodec.decode(decEid);
    if (statEid !== Status.Success) return err(statEid);
    const [off, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    const [ctr, s3] = dec.readVarInt();
    if (s3 !== Status.Success) return err(s3);
    const [len, s4] = dec.readVarInt();
    if (s4 !== Status.Success) return err(s4);
    let hsh: Uint8Array | undefined;
    if (len > 0) {
      const [h, s5] = dec.readBytes(hshBytes);
      if (s5 !== Status.Success) return err(s5);
      hsh = h;
    }
    return ok({
      eid: eid as EntityID,
      off,
      ctr,
      len,
      hsh,
    });
  },
};

/** Decrypt a 0.19.x export (heads without leading typ). */
export async function decodeV19File(
  file: Uint8Array,
  crypto: ICrypto,
  enclave: Enclave,
): Promise<ValStat<{ lbl: string; idx: number; msgs: Msg[] }>> {
  const [fileStruct, statDecode] = fileCodec.decode(new Decoder(file));
  if (statDecode !== Status.Success) return err(statDecode);
  const { head, indexEnc, bodyEnc } = fileStruct;

  const identity = await enclave.deriveIdentity(head.lbl, head.idx);
  const sigValid = await crypto.checkSigEd25519(
    head.sig,
    head.hsh,
    identity.publicKey,
  );
  if (!sigValid) return err(Status.InvalidSignature);

  const computedHsh = await crypto.blake3(indexEnc);
  if (!bytesEqual(computedHsh, head.hsh)) return err(Status.HashMismatch);

  const decoder = new Decoder(indexEnc);
  const items = [];
  for (let i = 0; i < head.num; i++) {
    const [item, itemStatus] = decoder.readStruct(fileIndexItemCodec);
    if (itemStatus !== Status.Success) return err(itemStatus);
    items.push(item);
  }
  if (items.length !== head.num) return err(Status.InvalidMessage);

  const msgs: Msg[] = [];
  for (const item of items) {
    const cipher = enclave.deriveCipher(item.kdm, "decrypt");
    let headEnc: Uint8Array;
    try {
      headEnc = await cipher.decrypt(item.headCph);
    } catch {
      return err(Status.DecryptionError);
    }
    const [msgHead, headStatus] = v19MessageHeadCodec.decode(
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
      try {
        itemBodyEnc = await cipher.decrypt(itemBodyCph);
      } catch {
        return err(Status.DecryptionError);
      }
      const hashItemBody = await crypto.blake3(itemBodyEnc);
      if (!bytesEqual(hashItemBody, msgHead.hsh)) {
        return err(Status.HashMismatch);
      }
    }
    msgs.push({ head: msgHead, body: itemBodyEnc });
  }
  return ok({ lbl: head.lbl, idx: head.idx, msgs });
}

/** True if v is a non-array object. */
function isPlainObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Lift IMsgEntBody.type onto the msg head and strip it from the msgpack body.
export async function hoistTyp(
  msgs: Iterable<Msg>,
  crypto: ICrypto,
): Promise<Msg[]> {
  const out: Msg[] = [];
  for (const msg of msgs) {
    const headTyp = msg.head.typ ?? "";
    if (!msg.body || msg.body.length === 0) {
      out.push({
        head: { ...msg.head, typ: headTyp },
        body: msg.body,
      });
      continue;
    }
    let decoded: unknown;
    try {
      decoded = decode(msg.body);
    } catch {
      out.push({
        head: { ...msg.head, typ: headTyp },
        body: msg.body,
      });
      continue;
    }
    if (!isPlainObj(decoded) || typeof decoded.type !== "string") {
      out.push({
        head: { ...msg.head, typ: headTyp },
        body: msg.body,
      });
      continue;
    }
    const typ = headTyp.length > 0 ? headTyp : decoded.type;
    const rest: Record<string, unknown> = {};
    for (const k of Object.keys(decoded)) {
      if (k !== "type") rest[k] = decoded[k];
    }
    const body = encode(rest);
    const hsh = await crypto.blake3(body);
    out.push({
      head: { ...msg.head, typ, len: body.length, hsh },
      body,
    });
  }
  return out;
}

if (import.meta.main) {
  const { Exim } = await import("../../shared/exim.ts");
  const crypto = (await import("../../bun/src/crypto.ts")).default;
  const {
    die,
    fidoDev,
    loadRing,
    parseLabel,
    ringPath,
    unlockRing,
  } = await import("../keys/cli-prf.ts");

  const [labelArg, inputFile, outputFile] = process.argv.slice(2);
  if (
    labelArg === undefined || inputFile === undefined ||
    labelArg === "-h" || labelArg === "--help"
  ) {
    console.error(
      "Usage: bun run hoist-typ.ts LABEL INPUT_FILE [OUTPUT_FILE]",
    );
    console.error("");
    console.error("  HOIST-TYP reads a 0.19.x DIPLOMATIC export and rewrites");
    console.error("  each msg so the ent type lives on the msg head instead");
    console.error("  of the msgpack body. Writes 0.20 heads (typ first).");
    console.error("  Same labeled CLI key encrypts the result.");
    console.error("  Unlock with a YubiKey UV (fido2-tools).");
    console.error("");
    console.error("  INPUT_FILE is the 0.19.x export to migrate (required).");
    console.error("  If OUTPUT_FILE is omitted, result is written to stdout.");
    console.error("  (All progress messages go to stderr.)");
    console.error("");
    console.error("Examples:");
    console.error("  bun run hoist-typ.ts home export.dpl migrated.dpl");
    console.error("  bun run hoist-typ.ts home export.dpl > migrated.dpl");
    process.exit(labelArg === "-h" || labelArg === "--help" ? 0 : 1);
  }

  const label = parseLabel(labelArg);
  const ring = loadRing(ringPath(label));
  if (ring === undefined) die(`no keyring for ${label}`);

  console.error(`Unlocking ${label}...`);
  const dev = fidoDev();
  console.error(`Using ${dev}`);
  const enclave = await unlockRing(ring, dev);

  console.error("Reading input file...");
  let input: Uint8Array;
  try {
    input = new Uint8Array(await Bun.file(inputFile).arrayBuffer());
  } catch (e) {
    die(`Failed to read input file ${inputFile}: ${e}`);
  }
  if (input.length === 0) die("Input file is empty.");
  console.error(`Read ${input.length} bytes from ${inputFile}.`);

  console.error("Decoding 0.19 heads...");
  const [decoded, stDec] = await decodeV19File(input, crypto, enclave);
  if (stDec !== Status.Success || decoded === undefined) {
    die(`Failed to decode 0.19 export: ${Status[stDec]}`);
  }
  console.error(`Decoded ${decoded.msgs.length} msgs.`);

  console.error("Hoisting typ onto msg heads...");
  const hoisted = await hoistTyp(decoded.msgs, crypto);

  console.error("Encoding 0.20 export...");
  const [outBytes, stEnc] = await Exim.encodeFile(
    decoded.lbl,
    decoded.idx,
    hoisted,
    crypto,
    enclave,
  );
  if (stEnc !== Status.Success || outBytes === undefined) {
    die(`Failed to encode: ${Status[stEnc]}`);
  }

  console.error("Writing migrated data...");
  if (outputFile !== undefined && outputFile.length > 0) {
    await Bun.write(outputFile, outBytes);
    console.error(`Wrote ${outBytes.length} bytes to ${outputFile}.`);
  } else {
    await Bun.write(Bun.stdout, outBytes);
    console.error(`Wrote ${outBytes.length} bytes to stdout.`);
  }

  console.error("Done.");
}
