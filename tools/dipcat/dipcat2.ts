import { initCLI } from "../../deno/src/cli2.ts";
import type { IMessage } from "../../shared/message.ts";
import denoMsgpack from "../../deno/src/codec.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";

const client = await initCLI();

const buf = new Uint8Array(1024);
const num = await Deno.stdin.read(buf);
if (!num) {
  Deno.exit(1);
}
const text = new TextDecoder().decode(buf.subarray(0, num));

// Msgpack encode the input string directly into the body of an insert IMessage
const content = denoMsgpack.encode(text);
const eid = await libsodiumCrypto.gen128BitRandomID();
const msg: IMessage = {
  eid,
  clk: new Date(),
  ctr: 0,
  len: content.length,
  bod: content,
};

await client.push(msg);
