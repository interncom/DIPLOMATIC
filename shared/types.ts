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
  addUser: (pubKeyHex: string) => Promise<void>;
  hasUser: (pubKeyHex: string) => Promise<boolean>;
  setOp: (path: string, op: Uint8Array) => Promise<void>;
  getOp: (path: string) => Promise<Uint8Array | undefined>;
  listOps: (pubKeyHex: string, begin: string, end: string) => Promise<string[]>;
}

export interface KeyPair {
  keyType: "public" | "private" | "secret";
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface IHostCrypto {
  checkSigEd25519: (sig: Uint8Array, message: Uint8Array, pubKey: Uint8Array) => Promise<boolean>;
}

export interface ICrypto extends IHostCrypto {
  gen256BitSecureRandomSeed: () => Promise<Uint8Array>;
  deriveXSalsa20Poly1305Key: (seed: Uint8Array, derivationIndex: number) => Promise<Uint8Array>;
  encryptXSalsa20Poly1305Combined: (plaintext: Uint8Array, key: Uint8Array) => Promise<Uint8Array>;
  decryptXSalsa20Poly1305Combined: (headerAndCipher: Uint8Array, key: Uint8Array) => Promise<Uint8Array>;
  deriveEd25519KeyPair: (seed: Uint8Array, hostID: string, derivationIndex: number) => Promise<KeyPair>;
  signEd25519: (message: Uint8Array | string, secKey: Uint8Array) => Promise<Uint8Array>;
}

export interface IMsgpackCodec {
  encode: (source: unknown) => Uint8Array;
  decode: (packed: ArrayBuffer | Uint8Array) => unknown;
  decodeAsync: (stream: ReadableStream<Uint8Array>) => Promise<unknown>;
}
