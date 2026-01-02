import { validateTsAuth } from "./auth.ts";
import { Decoder, Encoder } from "./codec.ts";
import { Status, tsAuthSize } from "./consts.ts";
import { binResp, callPaths, cors, respFor } from "./http.ts";
import type { IHostCrypto, IStorage, IWebsocketNotifier } from "./types.ts";

export class DiplomaticServer {
  constructor(
    public hostID: string,
    public storage: IStorage,
    public crypto: IHostCrypto,
    public notifier: IWebsocketNotifier,
  ) {}

  corsHandler = async (request: Request): Promise<Response> => {
    if (request.headers.get("upgrade") === "websocket") {
      return this.notifier.handler(
        request,
        this.storage.hasUser.bind(this.storage),
      );
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
    const tsAuthBytes = dec.readBytes(tsAuthSize);

    const [pubKey, status] = await validateTsAuth(tsAuthBytes, this.crypto);
    if (status !== Status.Success) {
      return respFor(status);
    }

    const path = url.pathname as keyof typeof callPaths;
    const endpoint = callPaths[path]?.endpoint;
    if (!endpoint) {
      return respFor(Status.NotFound);
    }
    if (endpoint.requiresRegisteredUser) {
      try {
        const userRegistered = await this.storage.hasUser(pubKey);
        if (!userRegistered) {
          return respFor(Status.UserNotRegistered);
        }
      } catch {
        return respFor(Status.InternalError);
      }
    }

    try {
      const ret = await endpoint.handleReq(this, pubKey, dec);
      if (ret instanceof Encoder) {
        return binResp(ret);
      } else {
        return respFor(ret);
      }
    } catch {
      return respFor(Status.InternalError);
    }
  };
}
