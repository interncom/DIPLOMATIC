import { ICodecStruct } from "../codec.ts";
import { hashBytes, Status } from "../consts.ts";

export interface IBagPushItem {
  status: Status;
  hash: Uint8Array;
}

export const pushItemCodec: ICodecStruct<IBagPushItem> = {
  encode(enc, item) {
    enc.writeBytes(new Uint8Array([item.status]));
    enc.writeBytes(item.hash);
  },
  decode(dec) {
    const status = dec.readBytes(1)[0];
    const hash = dec.readBytes(hashBytes);
    return { status, hash };
  },
};
