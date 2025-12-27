import { Status } from "./consts.ts";
import { Encoder, Decoder } from "./codec.ts";

// Named constants for API endpoint paths
export const HOST_PATH = "/id";
export const USER_PATH = "/users";
export const PUSH_PATH = "/ops";
export const PULL_PATH = "/pull";
export const PEEK_PATH = "/peek";

export function respFor(status: Status): Response {
  switch (status) {
    case Status.InvalidSignature:
      return new Response("Invalid signature", { status: 401 });
    case Status.ClockOutOfSync:
      return new Response("Clock out of sync", { status: 400 });
    case Status.UserNotRegistered:
      return new Response("Unauthorized", { status: 401 });
    case Status.ServerMisconfigured:
      return new Response("Server misconfigured", { status: 500 });
    case Status.MissingBody:
      return new Response("Missing request body", { status: 400 });
    case Status.ExtraBodyContent:
      return new Response("Extra body content", { status: 400 });
    case Status.MissingParam:
      return new Response("Missing from param", { status: 400 });
    case Status.InvalidParam:
      return new Response("Invalid from param", { status: 400 });
    case Status.InvalidRequest:
      return new Response("Invalid request format", { status: 400 });
    case Status.InternalError:
      return new Response("Internal error", { status: 500 });
    case Status.NotFound:
      return new Response("Not Found", { status: 404 });
    default:
      throw new Error(`Unhandled status: ${status}`);
  }
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

export async function post(url: URL, enc: Encoder): Promise<Decoder> {
  const response = await fetch(url, {
    method: "POST",
    body: enc.result().slice(),
  });
  if (!response.ok) {
    throw new Error("Request failed");
  }
  return await Decoder.fromResponse(response);
}
