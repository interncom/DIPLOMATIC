import { validateAuthTimestamp } from "../auth.ts";
import { htob } from "../binary.ts";
import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { authTimestampCodec, IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { IRespHead, respHeadCodec } from "../codecs/respHead.ts";
import { notifierTSAuthURLParam, Status } from "../consts.ts";
import { binResp, callPaths, cors, errResp } from "../http.ts";
import {
  nullSubMeta,
  type IHostCrypto,
  type IProtoHost,
  type IPushNotifier,
  type IStorage,
} from "../types.ts";
import { err, ok, ValStat } from "../valstat.ts";

export class DiplomaticHTTPServer implements IProtoHost {
  constructor(
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IPushNotifier,
    public clock: IClock,
  ) { }

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") {
      // Handle CORS preflight request
      return cors(new Response(null));
    }
    const logMsg = `${request.method} ${request.url}`;
    console.time(logMsg);
    const resp = await this.handler(request);
    console.timeEnd(logMsg);

    return cors(resp);
  };

  handler = async (request: Request): Promise<Response> => {
    const { clock } = this;
    const timeRcvd = clock.now();

    const url = new URL(request.url);

    // All requests are POST with authentication.
    if (request.method !== "POST") {
      const timeSent = clock.now();
      return errResp({
        status: Status.NotFound,
        timeRcvd,
        timeSent,
        subscription: nullSubMeta,
      });
    }

    const body = request.body;
    if (!body) {
      const timeSent = clock.now();
      return errResp({
        status: Status.MissingBody,
        timeRcvd,
        timeSent,
        subscription: nullSubMeta,
      });
    }
    const data = new Uint8Array(await request.arrayBuffer());
    const dec = new Decoder(data);

    const path = url.pathname as keyof typeof callPaths;
    const endpoint = callPaths[path]?.endpoint;
    if (!endpoint) {
      const timeSent = clock.now();
      return errResp({
        status: Status.NotFound,
        timeRcvd,
        timeSent,
        subscription: nullSubMeta,
      });
    }

    try {
      const enc = new Encoder();
      const status = await endpoint.handleReq(this, dec, enc);

      // Fetch subscription metadata.
      // const meta = await this.storage.subMeta();
      const meta = nullSubMeta; // TODO: use the real thing.

      // Construct response header.
      const head: IRespHead = {
        status,
        timeRcvd,
        timeSent: this.clock.now(),
        subscription: meta,
      };
      const encHead = new Encoder();
      const statEnc = encHead.writeStruct(respHeadCodec, head);
      if (statEnc !== Status.Success) {
        return new Response(null, { status: 500 });
      }

      // If request failed, return header alone (with failure status).
      if (status !== Status.Success) {
        const timeSent = clock.now();
        return errResp({
          status,
          timeRcvd,
          timeSent,
          subscription: nullSubMeta,
        });
      }

      // Prepend header to response encoder.
      enc.prependBytes(encHead.result());

      return binResp(enc);
    } catch (err) {
      const timeSent = clock.now();
      console.error(err);
      console.trace();
      return errResp({
        status: Status.InternalError,
        timeRcvd,
        timeSent,
        subscription: nullSubMeta,
      });
    }
  };
}

export async function validateWebSocketAuth(
  request: Request,
  host: IProtoHost,
): Promise<ValStat<IAuthTimestamp>> {
  const url = new URL(request.url);
  const authTSHex = url.searchParams.get(notifierTSAuthURLParam);
  if (!authTSHex) {
    return err(Status.InvalidRequest);
  }
  const authTSEnc = htob(authTSHex);
  const dec = new Decoder(authTSEnc);
  const [authTS, decStatus] = dec.readStruct(authTimestampCodec);
  if (decStatus !== Status.Success) {
    return err(Status.InvalidRequest);
  }
  const status = await validateAuthTimestamp(authTS, host.crypto, host.clock);
  if (status !== Status.Success) {
    return err(status);
  }
  return ok(authTS);
}
