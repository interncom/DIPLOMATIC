export enum Verb {
  DELETE = 0,
  UPSERT = 1,
}

// Body types are application-specific.
type Timestamp = string

export interface IOp {
  ts: Timestamp; // UTC unix timestamp
  type: string;
  verb: Verb;
  ver: number; // Version number, application-specific not about the protocol;
  body: unknown;
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

export interface IStorage {
  users: Set<string>;
  ops: Map<string, Uint8Array>;
}
