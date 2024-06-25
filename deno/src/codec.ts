import type { IMempackCodec } from "../../shared/types.ts";
import { decodeAsync, encode, decode } from "https://deno.land/x/msgpack@v1.4/mod.ts";

const denoMempack: IMempackCodec = {
  encode,
  decode,
  decodeAsync,
}
export default denoMempack;
