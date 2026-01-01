import { validateTsAuth } from "./auth.ts";
import { Decoder, Encoder } from "./codec.ts";

import { Status, tsAuthSize } from "./consts.ts";

import { apiPaths, binResp, cors, respFor } from "./http.ts";
import type {
  IHostCrypto,
  IStorage,
  IWebsocketNotifier,
  PublicKey,
} from "./types.ts";
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

  handleHost = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const ret = await hostEnd.handleReq(
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

  handleUser = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const ret = await userEnd.handleReq(
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

  handlePush = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const ret = await pushEnd.handleReq(
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

  handlePull = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const ret = await pullEnd.handleReq(
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

  handlePeek = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const ret = await peekEnd.handleReq(
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

    if (url.pathname === apiPaths.host) {
      return this.handleHost(pubKey, dec);
    }
    if (url.pathname === apiPaths.user) {
      return this.handleUser(pubKey, dec);
    }

    // Registered user required beyond this point.
    try {
      const userRegistered = await this.storage.hasUser(pubKey);
      if (!userRegistered) {
        return respFor(Status.UserNotRegistered);
      }
    } catch {
      return respFor(Status.InternalError);
    }

    if (url.pathname === apiPaths.push) {
      return this.handlePush(pubKey, dec);
    }
    if (url.pathname === apiPaths.pull) {
      return this.handlePull(pubKey, dec);
    }
    if (url.pathname === apiPaths.peek) {
      return this.handlePeek(pubKey, dec);
    }

    return respFor(Status.NotFound);
  };
}
