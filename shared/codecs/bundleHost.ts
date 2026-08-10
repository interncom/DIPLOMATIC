// Host connection row for identity/QR bundles (string URL handle).

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import type { IHostConnectionInfo } from "../types.ts";
import { err, ok } from "../valstat.ts";

/**
 * Wire form of {@link IHostConnectionInfo}: same fields, handle as string URL
 * (live clients use `URL | IProtoHost`).
 */
export type BundleHost = Omit<IHostConnectionInfo<URL>, "handle"> & {
  handle: string;
};

/** handle (varstring), label (varstring), idx (varint; default 0). */
export const bundleHostCodec: ICodecStruct<BundleHost> = {
  encode(enc, h) {
    const s0 = enc.writeVarString(h.handle);
    if (s0 !== Status.Success) return s0;
    const s1 = enc.writeVarString(h.label);
    if (s1 !== Status.Success) return s1;
    return enc.writeVarInt(h.idx ?? 0);
  },
  decode(dec) {
    const [handle, s0] = dec.readVarString();
    if (s0 !== Status.Success) return err(s0);
    const [label, s1] = dec.readVarString();
    if (s1 !== Status.Success) return err(s1);
    const [idx, s2] = dec.readVarInt();
    if (s2 !== Status.Success) return err(s2);
    return ok({ handle, label, idx });
  },
};
