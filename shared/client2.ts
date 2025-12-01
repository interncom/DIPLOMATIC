import type {
  ICrypto,
  IListDeltasResponse,
  IMsgpackCodec,
  IOperationRequest,
  IRegistrationRequest,
  KeyPair,
} from "./types.ts";
import { btoh } from "./lib.ts";
import { makeEnvelope, encodeEnvelope } from "./envelope.ts";
import { timestampAuthProof } from "./auth.ts";
import { encodeOp, type IMessage } from "./message.ts";

export default class DiplomaticClientAPI {
  codec: IMsgpackCodec;
  crypto: ICrypto;
  constructor(codec: IMsgpackCodec, crypto: ICrypto) {
    this.codec = codec;
    this.crypto = crypto;
  }

  async getHostID(hostURL: URL): Promise<string> {
    const url = new URL(hostURL);
    url.pathname = "/id";
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      throw "Uh oh";
    }
    const id = await response.text();
    return id;
  }

  async register(
    hostURL: URL,
    pubKey: Uint8Array,
    token: string,
  ): Promise<void> {
    const url = new URL(hostURL);
    url.pathname = "/users";
    const req: IRegistrationRequest = {
      token,
      pubKey, // TODO: check for valid pubKey length, server-side.
    };
    const reqPack = this.codec.encode(req);
    const response = await fetch(url, {
      method: "POST",
      body: reqPack.slice(0),
    });
    await response.body?.cancel();
  }

  async push(
    hostURL: URL,
    ops: IMessage[],
    seed: Uint8Array,
    keyPath: string,
    idx: number,
    now: Date,
  ): Promise<string> {
    const url = new URL(hostURL);
    url.pathname = "/ops";

    const keyPair = await this.crypto.deriveEd25519KeyPair(
      seed,
      keyPath,
      idx,
    );

    // Form the authentication prefix (sigproof of timestamp).
    // Server can reject for timestamp too far from its clock.
    // In that case, signal to user that clock is out of sync.
    // Clocks must be synchronized to ensure correct op order.

    const tsAuth = await timestampAuthProof(seed, keyPath, idx, now);

    // Derive encryption key
    const encKey = await this.crypto.deriveXSalsa20Poly1305Key(seed, idx);

    // Create a readable stream to stream the data
    const stream = new ReadableStream({
      async start(controller) {
        // First, send the tsAuth data
        const tsAuthEncoded = this.codec.encode(tsAuth);
        controller.enqueue(tsAuthEncoded);

        // Then, stream each envelope as it's generated
        for (const op of ops) {
          const encMsg = await encodeOp(op);
          const ciphertxt = await this.crypto.encryptXSalsa20Poly1305Combined(encMsg, encKey);
          const env = await makeEnvelope(idx, keyPair, ciphertxt, this.crypto);
          const encEnv = await encodeEnvelope(env);
          controller.enqueue(encEnv);
        }
        controller.close();
      }.bind(this),
    });

    const response = await fetch(url, {
      method: "POST",
      body: stream,
    });
    if (!response.ok) {
      throw "Uh oh";
    }
    const resp = await response.text();
    return resp;
  }
}
