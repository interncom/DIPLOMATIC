import { Status } from "../consts.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";

export const hostEnd: IAuthenticatedEndpoint<never, string> = {
  async encodeReq(_client, _keys, tsAuth, _body, reqEnc) {
    reqEnc.writeBytes(tsAuth);
  },
  requiresRegisteredUser: false,
  async handleReq(host, pubKey, reqDec, respEnc) {
    const { crypto, hostID } = host;
    if (!hostID) {
      return Status.ServerMisconfigured;
    }
    if (!reqDec.done()) {
      return Status.ExtraBodyContent;
    }
    const hash = await crypto.sha256Hash(pubKey);
    const suffix = btoa(String.fromCharCode(...hash.slice(0, 4)));
    const uniqueHostID = hostID + "-" + suffix;
    respEnc.writeVarInt(uniqueHostID.length);
    respEnc.writeBytes(new TextEncoder().encode(uniqueHostID));
    return Status.Success;
  },
  decodeResp(respDec) {
    const len = respDec.readVarInt();
    const bytes = respDec.readBytes(len);
    return new TextDecoder().decode(bytes);
  },
};
