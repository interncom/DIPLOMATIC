import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { IRespHead, respHeadCodec } from "../codecs/respHead.ts";
import { Status } from "../consts.ts";
import { binResp, callPaths, cors, errResp } from "../http.ts";
import {
  type IHostCrypto,
  type IProtoHost,
  type IStorage,
  type IWebSocketPushNotifier,
  nullSubMeta,
} from "../types.ts";

export class DiplomaticHTTPServer implements IProtoHost {
  constructor(
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IWebSocketPushNotifier,
    public clock: IClock,
  ) { }

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade") === "websocket") {
      return this.notifier.handle(this, request);
    }

    if (request.method === "OPTIONS") {
      // Handle CORS preflight request
      return cors(new Response(null));
    }
    const resp = await this.handler(request);

    console.log(`[${resp.status}] ${request.method} ${request.url}`);

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
