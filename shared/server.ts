import { validateTsAuth } from "./auth.ts";
import { Decoder, Encoder } from "./codec.ts";
import { bagCodec } from "./codecs/bag.ts";
import { peekItemCodec } from "./codecs/peekItem.ts";
import { type IBagPullItem, pullItemCodec } from "./codecs/pullItem.ts";
import { type IBagPushItem, pushItemCodec } from "./codecs/pushItem.ts";
import { hashBytes, Status, tsAuthSize } from "./consts.ts";
import { bagSigValid } from "./bag.ts";
import { apiPaths, binResp, cors, respFor } from "./http.ts";
import type {
  IHostCrypto,
  IStorage,
  IWebsocketNotifier,
  PublicKey,
} from "./types.ts";
import { hostEnd } from "./api/host.ts";

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
    const { hostID, storage, crypto, notifier } = this;
    const ret = await hostEnd.createResp(
      pubKey,
      dec,
      hostID,
      storage,
      crypto,
      notifier,
    );
    if (ret instanceof Encoder) {
      return binResp(ret);
    } else {
      return respFor(ret);
    }
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
    } catch (_err) {
      return respFor(Status.InternalError);
    }
  };

  handlePush = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { crypto, notifier, storage } = this;
    const now = new Date();
    try {
      const enc = new Encoder();
      for (const bag of dec.readStructs(bagCodec)) {
        const hash = await crypto.sha256Hash(bag.headCph);
        const sigValid = await bagSigValid(bag, pubKey, crypto);
        if (!sigValid) {
          const item: IBagPushItem = {
            status: Status.InvalidSignature,
            hash,
          };
          enc.writeStruct(pushItemCodec, item);
          continue;
        }
        await storage.setBag(pubKey, now, bag, hash);
        await notifier.notify(pubKey as PublicKey);
        const item: IBagPushItem = { status: Status.Success, hash };
        enc.writeStruct(pushItemCodec, item);
      }
      return binResp(enc);
    } catch (_err) {
      return respFor(Status.InternalError);
    }
  };

  handlePull = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { storage } = this;
    try {
      const enc = new Encoder();
      for (const headHash of dec.readBytesSeq(hashBytes)) {
        const bodyCph = await storage.getBody(pubKey, headHash);
        if (bodyCph) {
          const item: IBagPullItem = { hash: headHash, bodyCph };
          enc.writeStruct(pullItemCodec, item);
        }
      }
      return binResp(enc);
    } catch (_err) {
      return respFor(Status.InternalError);
    }
  };

  handlePeek = async (pubKey: PublicKey, dec: Decoder): Promise<Response> => {
    const { storage } = this;
    try {
      const from = dec.readDate();
      if (!dec.done()) {
        return respFor(Status.ExtraBodyContent);
      }

      const begin = from.toISOString();
      const end = new Date().toISOString();
      const items = await storage.listHeads(pubKey, begin, end);

      const enc = new Encoder();
      enc.writeStructs(peekItemCodec, items);
      return binResp(enc);
    } catch (_err) {
      return respFor(Status.InternalError);
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
