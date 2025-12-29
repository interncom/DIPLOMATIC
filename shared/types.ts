import type { IEnvelopePeekItem } from "./codecs/peekItem.ts";

export enum Verb {
  DELETE = 0,
  UPSERT = 1,
}

// Body types are application-specific.
type Timestamp = string;
export type GroupID = Uint8Array | string;
export type EntityID = Uint8Array;

export interface IBaseOp {
  eid: EntityID;
  ts: Timestamp; // UTC unix timestamp
  type: string;
  ver: number; // Version number, application-specific not about the protocol;
}

export interface IUpsertOp extends IBaseOp {
  gid?: GroupID; // Optional group ID to efficiently select a group of entities (will be indexed).
  pid?: EntityID; // Optional parent ID to support hierarchical structure.
  verb: Verb.UPSERT;
  body: unknown;
}

export interface IDeleteOp extends IBaseOp {
  verb: Verb.DELETE;
}

export type IOp = IUpsertOp | IDeleteOp;

export type CipherOp = Uint8Array; // encrypted serialized IOp

export interface ISyncRequest {
  ops: CipherOp[];
  begin: Timestamp;
}

export interface IRegistrationRequest {
  token: string;
  pubKey: Uint8Array;
}

export interface IOperationRequest {
  cipher: Uint8Array;
}

export interface IStorage {
  addUser: (pubKey: PublicKey) => Promise<void>;
  hasUser: (pubKey: PublicKey) => Promise<boolean>;
  setEnvelope: (
    pubKey: PublicKey,
    recordedAt: Date,
    env: IEnvelope,
    sha256: Uint8Array,
  ) => Promise<void>;
  getBody: (
    pubKey: PublicKey,
    sha256: Uint8Array,
  ) => Promise<Uint8Array | undefined>;
  listHeads: (
    pubKey: PublicKey,
    begin: string,
    end: string,
  ) => Promise<IEnvelopePeekItem[]>;
}

export interface KeyPair {
  keyType: "public" | "private" | "secret";
  privateKey: PrivateKey;
  publicKey: PublicKey;
}

const masterSeedSymbol = Symbol("MasterSeed");
const derivationSeedSymbol = Symbol("DerivationSeed");
const publicKeySymbol = Symbol("PublicKey");
const privateKeySymbol = Symbol("PrivateKey");

export type MasterSeed = Uint8Array & { readonly [masterSeedSymbol]: true };
export type DerivationSeed = Uint8Array & {
  readonly [derivationSeedSymbol]: true;
};
export type PublicKey = Uint8Array & { readonly [publicKeySymbol]: true };
export type PrivateKey = Uint8Array & { readonly [privateKeySymbol]: true };

export interface IHostCrypto {
  checkSigEd25519: (
    sig: Uint8Array,
    message: Uint8Array | string,
    pubKey: PublicKey,
  ) => Promise<boolean>;
  sha256Hash: (data: Uint8Array) => Promise<Uint8Array>;
  blake3: (data: Uint8Array) => Promise<Uint8Array>;
}

export interface ICrypto extends IHostCrypto {
  gen128BitRandomID: () => Promise<Uint8Array>;
  gen256BitSecureRandomSeed: () => Promise<Uint8Array>;
  deriveXSalsa20Poly1305Key: (
    seed: Uint8Array,
    derivationIndex: number,
  ) => Promise<Uint8Array>;
  encryptXSalsa20Poly1305Combined: (
    plaintext: Uint8Array,
    key: Uint8Array,
  ) => Promise<Uint8Array>;
  decryptXSalsa20Poly1305Combined: (
    headerAndCipher: Uint8Array,
    key: Uint8Array,
  ) => Promise<Uint8Array>;
  deriveEd25519KeyPair: (derivationSeed: DerivationSeed) => Promise<KeyPair>;
  signEd25519: (
    message: Uint8Array | string,
    secKey: PrivateKey,
  ) => Promise<Uint8Array>;
  blake3: (data: Uint8Array) => Promise<Uint8Array>;
}

export interface IMsgpackCodec {
  encode: (source: unknown) => Uint8Array;
  decode: (packed: ArrayBuffer | Uint8Array) => unknown;
  decodeAsync: (stream: ReadableStream<Uint8Array>) => Promise<unknown>;
}

export interface IWebsocketNotifier {
  handler: (
    request: Request,
    hasUser: (pubKey: PublicKey) => Promise<boolean>,
  ) => Promise<Response>;
  notify: (pubKey: PublicKey) => Promise<void>;
}

export interface IEnvelopeHeader {
  sig: Uint8Array;
  kdm: Uint8Array;
  lenHeadCph: number;
  lenBodyCph: number;
}

export interface IEnvelope extends IEnvelopeHeader {
  headCph: Uint8Array;
  bodyCph: Uint8Array;
}

export type EncodedEnvelope = Uint8Array;
