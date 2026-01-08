import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { APICallName, Status } from "../consts.ts";
import { apiCalls, binResp, callPaths, cors, respFor } from "../http.ts";
import type { IHostCrypto, IPushNotifier, IStorage } from "../types.ts";

export class DiplomaticLPCServer {
  constructor(
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IPushNotifier,
    public clock: IClock,
  ) { }

  // To listen to notifier over LPC, just access .notifier on this host directly.

  handler = async (callName: APICallName, dec: Decoder, enc: Encoder): Promise<Status> => {
    const call = apiCalls[callName];
    if (!call) {
      return Status.NotFound;
    }
    const status = await call.endpoint.handleReq(this, dec, enc);
    return status;
  }
}
