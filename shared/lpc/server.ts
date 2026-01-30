import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { APICallName, Status } from "../consts.ts";
import { apiCalls } from "../http.ts";
import type {
  IHostCrypto,
  IProtoHost,
  IPushListener,
  IPushNotifier,
  IStorage,
  ITransport,
} from "../types.ts";
import { CallbackListener } from "./listener.ts";
import { ValStat, err, ok } from "../valstat.ts";
import { respHeadCodec } from "../codecs/respHead.ts";

export class DiplomaticLPCServer implements IProtoHost {
  constructor(
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IPushNotifier,
    public clock: IClock,
  ) { }

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
    const reqBody = enc.result();
    const reqDec = new Decoder(reqBody);
    const respEnc = new Encoder();
    const status = await this.host.handler(name, reqDec, respEnc);

    const headEnc = new Encoder();
    const statEnc = headEnc.writeStruct(respHeadCodec, { status });
    if (statEnc !== Status.Success) {
      return err(statEnc);
    }

    respEnc.prependBytes(headEnc.result());
    return ok(new Decoder(respEnc.result()));
  };
}
