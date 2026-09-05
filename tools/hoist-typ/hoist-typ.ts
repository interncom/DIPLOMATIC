import { decode, encode } from "@msgpack/msgpack";
import type { ICrypto, IMessageHead } from "../../shared/types.ts";

type Msg = { head: IMessageHead; body?: Uint8Array };

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
  const { Status } = await import("../../shared/consts.ts");
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
    console.error("  HOIST-TYP reads a DIPLOMATIC export and rewrites each msg");
    console.error("  so the ent type lives on the msg head instead of the");
    console.error("  msgpack body. Same labeled CLI key encrypts the result.");
    console.error("  Unlock with a YubiKey UV (fido2-tools).");
    console.error("");
    console.error("  INPUT_FILE is the export to migrate (required).");
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
  } catch (err) {
    die(`Failed to read input file ${inputFile}: ${err}`);
  }
  if (input.length === 0) die("Input file is empty.");
  console.error(`Read ${input.length} bytes from ${inputFile}.`);

  console.error("Hoisting typ onto msg heads...");
  const [outBytes, statMig] = await Exim.migrateFile(
    input,
    crypto,
    enclave,
    enclave,
    (msgs) => hoistTyp(msgs, crypto),
  );
  if (statMig !== Status.Success || outBytes === undefined) {
    die(`Failed to migrate: ${Status[statMig]}`);
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
