import type {
  IHostCrypto,
  IListDeltasResponse,
  IOperationRequest,
  IRegistrationRequest,
  IStorage,
  IWebsocketNotifier,
  PublicKey,
  IEnvelope,
  IEnvelopeHeader,
} from "./types.ts";
import { btoh, htob, uint8ArraysEqual } from "./lib.ts";
import {
  tsAuthSize,
  envelopeHeaderSize,
  hashSize,
  responseItemSize,
  sigBytes,
  kdmBytes,
} from "./consts.ts";
import {
  encodeEnvelope,
  decodeEnvelope,
  decodeEnvelopeHeader,
  envSigValid,
} from "./envelope.ts";
import { Decoder, Encoder } from "./codec.ts";
import {
  HOST_PATH,
  USER_PATH,
  PUSH_PATH,
  PULL_PATH,
  PEEK_PATH,
  respFor,
  binResp,
  cors,
} from "./http.ts";
import { Status } from "./consts.ts";
import { encodePeekItem, encodePullItem, encodePushItem } from "./protocol.ts";
import { validateTsAuth } from "./auth.ts";

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

  handleHost = async (request: Request): Promise<Response> => {
    if (!this.hostID) {
      return respFor(Status.ServerMisconfigured);
    }
    return new Response(this.hostID, { status: 200 });
  };

  handleUser = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { storage } = this;
    if (!dec.done()) {
      return respFor(Status.ExtraBodyContent);
    }
    try {
      // Register the public key
      await storage.addUser(pubKey);
      return new Response("", { status: 200 });
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePush = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { crypto, notifier, storage } = this;
    const now = new Date();
    try {
      const enc = new Encoder();
      while (!dec.done()) {
        const env = decodeEnvelope(dec);
        const hash = await crypto.sha256Hash(env.headCph);
        const sigValid = await envSigValid(env, pubKey, crypto);
        if (!sigValid) {
          encodePushItem({ status: Status.InvalidSignature, hash }, enc);
          continue;
        }
        await storage.setEnvelope(pubKey, now, env, hash);
        await notifier.notify(pubKey as PublicKey);
        encodePushItem({ status: Status.Success, hash }, enc);
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePull = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { storage } = this;
    try {
      const enc = new Encoder();
      while (!dec.done()) {
        const headHash = dec.readBytes(hashSize);
        const bodyCph = await storage.getBody(pubKey, headHash);
        if (bodyCph) {
          encodePullItem({ hash: headHash, bodyCph }, enc);
        }
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handlePeek = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { storage } = this;
    try {
      const fromMillis = dec.readVarInt();
      if (!dec.done()) {
        return respFor(Status.ExtraBodyContent);
      }

      const begin = new Date(fromMillis).toISOString();
      const end = new Date().toISOString();
      const items = await storage.listHeads(pubKey, begin, end);

      const enc = new Encoder();
      for (const item of items) {
        encodePeekItem(item, enc);
      }
      return binResp(enc);
    } catch (err) {
      return respFor(Status.InternalError);
    }
  };

  handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === HOST_PATH) {
      return this.handleHost(request);
    }

    // Timestamp authentication required beyond this point.
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

    if (request.method === "POST" && url.pathname === USER_PATH) {
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

    if (request.method === "POST" && url.pathname === PUSH_PATH) {
      return this.handlePush(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === PULL_PATH) {
      return this.handlePull(pubKey, dec);
    }
    if (request.method === "POST" && url.pathname === PEEK_PATH) {
      return this.handlePeek(pubKey, dec);
    }

    return respFor(Status.NotFound);
  };
}
