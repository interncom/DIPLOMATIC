import { IClock } from "./clock.ts";
import { Decoder, Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import { Status } from "./consts.ts";
import { Enclave } from "./enclave.ts";
import { HostSpecificKeyPair, ICrypto, IProtoHost } from "./types.ts";
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
    keys: HostSpecificKeyPair,
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
  keys: HostSpecificKeyPair;
  authTS: IAuthTimestamp;
}

export async function hostKeys(
  host: IProtoClient,
  keyPath: string,
  idx: number,
): Promise<HostSpecificKeyPair> {
  const { crypto, enclave } = host;
  const derivSeed = await enclave.derive(keyPath, idx);
  const keys = await crypto.deriveEd25519KeyPair(derivSeed);
  return keys as HostSpecificKeyPair;
}
