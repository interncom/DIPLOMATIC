import type { IMsgpackCodec } from "../../shared/types.ts";
import {
  decode,
  decodeAsync,
  encode,
} from "https://deno.land/x/msgpack@v1.2/mod.ts";

const denoMempack: IMsgpackCodec = {
  encode,
  decode,
  decodeAsync,
};
export default denoMempack;
