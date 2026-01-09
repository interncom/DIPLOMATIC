import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";
import { Hash } from "../types.ts";

export interface IBagPushItem {
  status: Status;
  hash: Hash;
}

export const pushItemCodec: ICodecStruct<IBagPushItem> = {
  encode(enc, item) {
    enc.writeBytes(new Uint8Array([item.status]));
    enc.writeBytes(item.hash);
  },
  decode(dec) {
    const status = dec.readBytes(1)[0];
    const hash = dec.readBytes(hashBytes) as Hash;
    return { status, hash };
  },
};
