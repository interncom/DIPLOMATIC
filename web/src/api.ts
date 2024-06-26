import { encode, decode, decodeAsync } from "@msgpack/msgpack";
import libsodiumCrypto from "./crypto";
import DiplomaticClientAPI from "./shared/client";
import type { IMsgpackCodec } from "./shared/types";

const msgpack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
}
const webClientAPI = new DiplomaticClientAPI(msgpack, libsodiumCrypto);
export default webClientAPI;
