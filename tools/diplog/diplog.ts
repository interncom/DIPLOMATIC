import DiplomaticClientAPI from "../../shared/client.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";
import denoMsgpack from "../../deno/src/codec.ts";
import { htob } from "../../shared/lib.ts";

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

const t0 = new Date(0);
const resp = await client.getDeltaPaths(url, t0, keyPair);
for (const path of resp.paths) {
  const cipher = await client.getDelta(hostURL, path, keyPair);
  const packed = await libsodiumCrypto.decryptXSalsa20Poly1305Combined(cipher, encKey);
  const op = denoMsgpack.decode(packed);
  console.log(op);
}
