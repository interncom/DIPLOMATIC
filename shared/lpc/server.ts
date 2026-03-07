import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { APICallName, Status } from "../consts.ts";
import { apiCalls } from "../http.ts";
import {
  type IHostCrypto,
  type IProtoHost,
  type IPushListener,
  type IPushNotifier,
  type IStorage,
  type ITransport,
  nullSubMeta,
} from "../types.ts";
import { CallbackListener } from "./listener.ts";
import { err, ok, ValStat } from "../valstat.ts";
import { IRespHead, respHeadCodec } from "../codecs/respHead.ts";

export class DiplomaticLPCServer implements IProtoHost {
  constructor(
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IPushNotifier,
    public clock: IClock,
  ) {}

  // To listen to notifier over LPC, just access .notifier on this host directly.

  handler = async (
    callName: APICallName,
    dec: Decoder,
    enc: Encoder,
  ): Promise<Status> => {
    const call = apiCalls[callName];
    if (!call) {
      return Status.NotFound;
    }
    const status = await call.endpoint.handleReq(this, dec, enc);
    return status;
  };
}

export class LPCTransport implements ITransport {
  public listener: IPushListener;
  constructor(private host: DiplomaticLPCServer) {
    this.listener = new CallbackListener(
      host.notifier,
      host.crypto,
      host.clock,
    );
  }

  call = async (name: APICallName, enc: Encoder): Promise<ValStat<Decoder>> => {
    const { clock } = this.host;
    const timeRcvd = clock.now();

    const reqBody = enc.result();
    const reqDec = new Decoder(reqBody);
    const respEnc = new Encoder();
    const status = await this.host.handler(name, reqDec, respEnc);

    const headEnc = new Encoder();
    const timeSent = clock.now();
    const subscription = nullSubMeta;
    const head: IRespHead = { status, timeRcvd, timeSent, subscription };
    const statEnc = headEnc.writeStruct(respHeadCodec, head);
    if (statEnc !== Status.Success) {
      return err(statEnc);
    }

    respEnc.prependBytes(headEnc.result());
    const respDec = new Decoder(respEnc.result());
    return ok(respDec);
  };
}
