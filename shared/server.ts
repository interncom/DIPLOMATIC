import { validateTsAuth } from "./auth.ts";
import { Decoder, Encoder } from "./codec.ts";
import { Status, tsAuthSize } from "./consts.ts";
import { apiPaths, binResp, cors, respFor } from "./http.ts";
import type { IHostCrypto, IStorage, IWebsocketNotifier } from "./types.ts";
import { hostEnd } from "./api/host.ts";
import { peekEnd } from "./api/peek.ts";
import { pullEnd } from "./api/pull.ts";
import { pushEnd } from "./api/push.ts";
import { userEnd } from "./api/user.ts";

export class DiplomaticServer {
  constructor(
    private hostID: string,
    private storage: IStorage,
    private crypto: IHostCrypto,
    private notifier: IWebsocketNotifier,
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

    const path = url.pathname as keyof typeof endpoints;
    const endpoint = endpoints[path];
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

    const ret = await endpoint.handleReq(
      pubKey,
      dec,
      this.hostID,
      this.storage,
      this.crypto,
      this.notifier,
    );
    if (ret instanceof Encoder) {
      return binResp(ret);
    } else {
      return respFor(ret);
    }
  };
}

const endpoints = {
  [apiPaths.host]: hostEnd,
  [apiPaths.user]: userEnd,
  [apiPaths.push]: pushEnd,
  [apiPaths.peek]: peekEnd,
  [apiPaths.pull]: pullEnd,
} as const;
