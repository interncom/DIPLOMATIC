import { Encoder } from "../codec.ts";
import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const hostEnd: IAuthenticatedEndpoint<never, string> = {
  async encodeReq(_client, _keys, tsAuth, _body) {
    const enc = new Encoder();
    enc.writeBytes(tsAuth);
    return enc;
  },
  requiresRegisteredUser: false,
  async handleReq(host, pubKey, dec) {
    const { crypto, hostID } = host;
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
  decodeResp(dec) {
    const len = dec.readVarInt();
    const bytes = dec.readBytes(len);
    return new TextDecoder().decode(bytes);
  },
};
