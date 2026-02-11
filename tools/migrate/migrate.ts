// Migrates exports from legacy format to v0.1 file format.

import { ZipReader, BlobReader, Uint8ArrayWriter } from "https://deno.land/x/zipjs@v2.8.15/index.js";
import libsodiumCrypto from "../../deno/src/crypto.ts";
import denoMempack from "../../deno/src/codec.ts";
import { btoh, htob } from "../../shared/binary.ts";
import { encodeFile } from "../../shared/exim.ts";
import { Enclave } from "../../shared/enclave.ts";
import { IMessageHead, MasterSeed } from "../../shared/types.ts";
import { eidBytes, Status } from "../../shared/consts.ts";
import { err, ok, ValStat } from "../../shared/valstat.ts";
import { makeEID } from "../../shared/codecs/eid.ts";

async function importLegacy(filePath: string, encKey: Uint8Array): Promise<ValStat<Uint8Array>> {
  const data = await Deno.readFile(filePath);
  const zipReader = new ZipReader(new BlobReader(new Blob([data])));

  // Load ops into an array (necessary to sort and assign ctrs which didn't exist in legacy).
  console.time("Reading...");
  const ops: any[] = [];
  const entries = await zipReader.getEntries();
  for (const entry of entries) {
    const cipher = await entry.getData(new Uint8ArrayWriter());
    const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(
      cipher,
      encKey,
    );
    const op = denoMempack.decode(packed);
    ops.push(op);
  }
  await zipReader.close();
  console.timeEnd("Reading...");

  // Sort ascending by timestamp.
  console.time("Sorting...");
  ops.sort((o1, o2) => o1.ts.localeCompare(o2.ts));
  console.timeEnd("Sorting...");

  // Assign ctrs and transform into new structure.
  console.time("Transforming...");
  const counters = new Map<string, number>();
  const createds = new Map<string, Date>(); // When the eid was first seen
  const msgs: Array<{ head: IMessageHead, body?: Uint8Array }> = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const { eid: id, gid, pid, ts: tsRaw, type, verb, ver, body: opBody } = op;

    const eidHex = btoh(id);
    const prevCtr = counters.get(eidHex);
    const ctr = (prevCtr ?? -1) + 1;
    counters.set(eidHex, ctr);

    const ts = new Date(tsRaw);
    const createdAt = createds.get(eidHex) ?? ts;
    createds.set(eidHex, createdAt);

    const off = ts.getTime() - createdAt.getTime();

    const eidObj = { id, ts: createdAt };
    const [eid, statEid] = makeEID(eidObj);
    if (statEid !== Status.Success) {
      console.warn(`error transforming EID: ${eidHex}\t${ts} (${statEid})`);
      continue;
    }

    try {
      const body: any = opBody ? { body: opBody, type } : { type };
      if (pid) {
        body.pid = pid;
      }
      if (gid) {
        body.gid = gid;
      }
      const bodyEnc = denoMempack.encode(body);

      const head: IMessageHead = {
        eid,
        ctr,
        off,
        len: bodyEnc?.length ?? 0,
        hsh: await libsodiumCrypto.blake3(bodyEnc),
      }

      msgs.push({ head, body: bodyEnc });
    } catch (err) {
      console.error("AAAAH", eidHex, err)
    }
  }
  console.timeEnd("Transforming...");

  const enclave = new Enclave(seed as MasterSeed, libsodiumCrypto);
  console.time("Encoding...");
  const [output, stat] = await encodeFile("export", 0, msgs, libsodiumCrypto, enclave);
  console.timeEnd("Encoding...");
  if (stat !== Status.Success) {
    return err(stat);
  }
  return ok(output);
};

const inFilename = Deno.args[0];
const outFilename = Deno.args[1];
if (!inFilename || !outFilename) {
  console.error("usage: deno run --allow-read --allow-write --allow-env=DIPLOMATIC_SEED migrate.ts INFILE OUTFILE");
  Deno.exit(1);
}

const seedHex = await Deno.env.get("DIPLOMATIC_SEED");
if (!seedHex) {
  console.error("Must set DIPLOMATIC_SEED to hex encoded seed");
  Deno.exit(1);
}
const seed = htob(seedHex.trim());
const encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);

const [bytes, stat] = await importLegacy(inFilename, encKey);
if (stat !== Status.Success) {
  console.error("Writing export", stat);
} else {
  await Deno.writeFile(outFilename, bytes);
}
