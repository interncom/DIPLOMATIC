enum Verb {
  DELETE = 0,
  UPSERT = 1,
}

// Body types are application-specific.
type OpBody = {
  test: unknown;
  status: string;
};
type OpType = keyof OpBody;

type Timestamp = string

export interface IOp<T extends OpType> {
  ts: Timestamp; // UTC unix timestamp
  type: T;
  verb: Verb;
  ver: number; // Version number, application-specific not about the protocol;
  body: OpBody[T];
}

export type CipherOp = Uint8Array // encrypted serialized IOp

export interface ISyncRequest {
  ops: CipherOp[],
  begin: Timestamp,
}

export interface IRegistrationRequest {
  token: string;
  pubKey: Uint8Array;
}

export interface IOperationRequest {
  cipher: Uint8Array;
}

export interface IGetDeltaPathsResponse {
  paths: string[];
  fetchedAt: string;
}
