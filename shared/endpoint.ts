// Endpoint is an abstraction bundling the client and server sides of the API.
// This keeps the binary encoding and decoding logic together for each request.
// Endpoint implementations live in the api dir.

import { IClock } from "./clock.ts";
import { Decoder, Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import { Status } from "./consts.ts";
import { Enclave, type Identity } from "./enclave.ts";
import { ICrypto, IProtoHost } from "./types.ts";
import { ValStat } from "./valstat.ts";

interface IProtoClient {
  crypto: ICrypto;
  enclave: Enclave;
  clock: IClock;
}

export interface IAuthenticatedEndpoint<ReqItem, Resp> {
  // encodeReq writes request data to the provided reqEnc.
  encodeReq(
    client: IProtoClient,
    identity: Identity,
    authTS: IAuthTimestamp,
    body: Iterable<ReqItem>,
    reqEnc: Encoder,
  ): Promise<Status>;

  // handleReq reads request data from reqDec and writes to respEnc.
  handleReq(
    host: IProtoHost,
    reqDec: Decoder,
    respEnc: Encoder,
  ): Promise<Status>;

  // decodeResp reads response data from respDeck and parses it.
  decodeResp(respDec: Decoder): ValStat<Resp>;
}

export interface IAuthData {
  identity: Identity;
  authTS: IAuthTimestamp;
}
