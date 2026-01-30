import { IClock } from "../clock.ts";
import { Decoder, Encoder } from "../codec.ts";
import { IRespHead, respHeadCodec } from "../codecs/respHead.ts";
import { Status } from "../consts.ts";
import { binResp, callPaths, cors, respFor } from "../http.ts";
import type {
  IHostCrypto,
  IProtoHost,
  IStorage,
  IWebSocketPushNotifier,
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
    const url = new URL(request.url);

    // All requests are POST with authentication.
    if (request.method !== "POST") {
      return respFor(Status.NotFound);
    }

    const body = request.body;
    if (!body) {
      return respFor(Status.MissingBody);
    }
    const data = new Uint8Array(await request.arrayBuffer());
    const dec = new Decoder(data);

    const path = url.pathname as keyof typeof callPaths;
    const endpoint = callPaths[path]?.endpoint;
    if (!endpoint) {
      return respFor(Status.NotFound);
    }

    try {
      const enc = new Encoder();
      const status = await endpoint.handleReq(this, dec, enc);

      // Construct response header.
      const head: IRespHead = {
        status,
      };
      const encHead = new Encoder();
      const statEnc = encHead.writeStruct(respHeadCodec, head);
      if (statEnc !== Status.Success) {
        return new Response(null, { status: 500 });
      }

      // If request failed, return header alone (with failure status).
      if (status !== Status.Success) {
        return respFor(status);
      }

      // Prepend header to response encoder.
      enc.prependBytes(encHead.result());

      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };
}
