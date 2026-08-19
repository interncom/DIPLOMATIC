// Host list after a fixed 32-byte master seed (largeBlob persist and pair
// AEAD inner). This codec never sees seed bytes.

import { ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok } from "../valstat.ts";
import { type BundleHost, bundleHostCodec } from "./bundleHost.ts";

export { type BundleHost, bundleHostCodec } from "./bundleHost.ts";

export type IdentityHosts = {
  hosts: BundleHost[];
};

/**
 * Host list on the IdentityBundle wire:
 *   hostsLen: varint
 *   hosts: hostsLen × BundleHost
 */
export const identityHostsCodec: ICodecStruct<IdentityHosts> = {
  encode(enc, b) {
    const s0 = enc.writeVarInt(b.hosts.length);
    if (s0 !== Status.Success) return s0;
    for (const h of b.hosts) {
      const s1 = enc.writeStruct(bundleHostCodec, h);
      if (s1 !== Status.Success) return s1;
    }
    return Status.Success;
  },
  decode(dec) {
    const [n, s0] = dec.readVarInt();
    if (s0 !== Status.Success) return err(s0);
    if (n === undefined || n < 0) return err(Status.InvalidParam);
    const hosts: BundleHost[] = [];
    for (let i = 0; i < n; i++) {
      const [h, s1] = dec.readStruct(bundleHostCodec);
      if (s1 !== Status.Success) return err(s1);
      if (h === undefined) return err(Status.InvalidMessage);
      hosts.push(h);
    }
    return ok({ hosts });
  },
};
