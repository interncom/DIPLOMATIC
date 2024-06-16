enum Verb {
  CREATE = 1,
  UPDATE = 2,
  DELETE = 3,
}

// Body types are application-specific.
type OpBody = {
  test: unknown;
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
}
