import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const hostEnd: IAuthenticatedEndpoint<never> = {
  async encodeReq(tsAuth, _body, _keys, _crypto, _enclave) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    return enc;
  },
  async createResp(pubKey, dec, hostID, _storage, crypto, _notifier) {
    if (!hostID) {
      return Status.ServerMisconfigured;
    }
    if (!dec.done()) {
      return Status.ExtraBodyContent;
    }
    const hash = await crypto.sha256Hash(pubKey);
    const suffix = btoa(String.fromCharCode(...hash.slice(0, 4)));
    const uniqueHostID = hostID + "-" + suffix;
    const enc = new Encoder();
    enc.writeVarInt(uniqueHostID.length);
    enc.writeBytes(new TextEncoder().encode(uniqueHostID));
    return enc;
  },
};
