import type { IMsgpackCodec } from "../../shared/types.ts";
import {
  decode,
  decodeAsync,
  encode,
} from "@msgpack/msgpack";

const bunMsgpack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
};
export default bunMsgpack;