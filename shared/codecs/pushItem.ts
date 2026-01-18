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
    return Status.Success;
  },
  decode(dec) {
    const [statusBytes, stat1] = dec.readBytes(1);
    if (stat1 !== Status.Success) return [undefined, stat1];
    const [hash, stat2] = dec.readBytes(hashBytes);
    if (stat2 !== Status.Success) return [undefined, stat2];
    return [{ status: statusBytes[0], hash: hash as Hash }, Status.Success];
  },
};
