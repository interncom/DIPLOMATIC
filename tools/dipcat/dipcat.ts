import DiplomaticClientAPI from "../../shared/client.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";
import denoMsgpack from "../../deno/src/codec.ts";
import { htob } from "../../shared/lib.ts";
import { isOp } from "../../shared/ops.ts";

const hostURL = Deno.env.get("DIPLOMATIC_HOST_URL");
const seedHex = Deno.env.get("DIPLOMATIC_SEED_HEX");
if (!hostURL) {
  throw "Missing DIPLOMATIC_HOST_URL env var"
}
if (!seedHex) {
  throw "Missing DIPLOMATIC_SEED_HEX env var"
}

const regToken = "tok123";
const seed = htob(seedHex);
const encKey = await libsodiumCrypto.deriveXSalsa20Poly1305Key(seed);

const client = new DiplomaticClientAPI(denoMsgpack, libsodiumCrypto);

const url = new URL(hostURL);
const hostID = await client.getHostID(url);

const keyPair = await libsodiumCrypto.deriveEd25519KeyPair(seed, hostID);

await client.register(url, keyPair.publicKey, regToken);

// Put op.
const buf = new Uint8Array(1024);
const num = await Deno.stdin.read(buf);
if (!num) {
  Deno.exit(1);
}
const text = new TextDecoder().decode(buf.subarray(0, num));
try {
  const op = JSON.parse(text);
  if (!isOp(op)) {
    console.error("Invalid input")
    Deno.exit(1);
  }
  const packed = denoMsgpack.encode(op);
  const cipherOp = await libsodiumCrypto.encryptXSalsa20Poly1305Combined(packed, encKey);
  await client.putDelta(hostURL, cipherOp, keyPair);
} catch (err) {
  console.error("Error parsing input", err)
  Deno.exit(1);
}
