// HTTP transport layer details.
// DIPLOMATIC runs over HTTP but is only very loosely decoupled to it.
// For instance, we avoid using HTTP status codes to signal status.
// We can easily swap in a new transport layer.

import { Decoder, Encoder } from "./codec.ts";
import { APICallName, Status } from "./consts.ts";

import { peekEnd } from "./api/peek.ts";
import { pullEnd } from "./api/pull.ts";
import { pushEnd } from "./api/push.ts";
import { userEnd } from "./api/user.ts";
import { IPushListener, ITransport } from "./types.ts";
import { WebsocketListener } from "./http/listener.ts";
import { IRespHead, respHeadCodec } from "./codecs/respHead.ts";
import { err, ok, ValStat } from "./valstat.ts";

export const api = {
  user: {
    path: "/user",
    endpoint: userEnd,
    name: APICallName.User,
  },
  push: {
    path: "/push",
    endpoint: pushEnd,
    name: APICallName.Push,
  },
  peek: {
    path: "/peek",
    endpoint: peekEnd,
    name: APICallName.Peek,
  },
  pull: {
    path: "/pull",
    endpoint: pullEnd,
    name: APICallName.Pull,
  },
} as const;

export const apiCalls = {
  [APICallName.User]: api.user,
  [APICallName.Push]: api.push,
  [APICallName.Peek]: api.peek,
  [APICallName.Pull]: api.pull,
} as const;

export const callPaths = {
  [api.user.path]: api.user,
  [api.push.path]: api.push,
  [api.peek.path]: api.peek,
  [api.pull.path]: api.pull,
} as const;

export class HTTPTransport implements ITransport {
  public listener: IPushListener;
  constructor(private url: URL) {
    this.listener = new WebsocketListener(url);
  }

  async call(name: APICallName, enc: Encoder) {
    const { path } = apiCalls[name];
    const url = new URL(path, this.url);
    try {
      const resp = await post(url, enc);
      return resp;
    } catch {
      return err<Decoder>(Status.CommunicationError);
    }
  }
}

export function errResp(head: IRespHead): Response {
  const enc = new Encoder();
  const statEnc = enc.writeStruct(respHeadCodec, head);
  if (statEnc !== Status.Success) {
    return new Response(null, { status: 500 });
  }
  return binResp(enc);
}

export function binResp(encoder: Encoder): Response {
  // TODO: fix types so it doesn't need the .slice().
  const data = encoder.result().slice();
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow any origin
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function cors(resp: Response): Response {
  return new Response(resp.body, {
    headers: { ...resp.headers, ...corsHeaders },
    status: resp.status,
    statusText: resp.statusText,
  });
}

export async function post(url: URL, enc: Encoder): Promise<ValStat<Decoder>> {
  const response = await fetch(url, {
    method: "POST",
    body: enc.result().slice(),
  });
  if (!response.ok) {
    return err(Status.HostError);
  }
  const dec = await Decoder.fromResponse(response);
  return ok(dec);
}
