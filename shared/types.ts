import { IClock } from "./clock.ts";
import { Decoder, Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import type { IBagPeekItem } from "./codecs/peekItem.ts";
import { APICallName, Status } from "./consts.ts";

// ValStat is a return value paired with a status code (for Go-style errors).
export type ValStat<T> =
  | [T, Status.Success]
  | [undefined, Exclude<Status, Status.Success>];

export type GroupID = Uint8Array | string;
export type EntityID = Uint8Array;

export interface IOp {
  ts: Date;
  ctr: number;
  eid: EntityID;
  // aid?: AppID // Optional app ID to distinguish data from different apps in same database? TODO: think this one through.
  gid?: GroupID; // Optional group ID to efficiently select a group of entities (will be indexed).
  pid?: EntityID; // Optional parent ID to support hierarchical structure.
  type: string;
  body?: unknown;
}

export type IInsertParams = Omit<IOp, "ts" | "ctr" | "eid">;
export type IUpsertParams = Omit<IOp, "ts" | "ctr">;

export interface IStorage {
  addUser: (pubKey: PublicKey) => Promise<ValStat<void>>;
  hasUser: (pubKey: PublicKey) => Promise<ValStat<boolean>>;
  setBag: (
    pubKey: PublicKey,
    recordedAt: Date,
    bag: IBag,
    sha256: Uint8Array,
  ) => Promise<ValStat<void>>;
  getBody: (
    pubKey: PublicKey,
    sha256: Uint8Array,
  ) => Promise<ValStat<Uint8Array | undefined>>;
  listHeads: (
    pubKey: PublicKey,
    begin: string,
    end: string,
  ) => Promise<ValStat<IBagPeekItem[]>>;
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
const hostSpecificKeyPairSymbol = Symbol("HostSpecificKeyPair");
const hashSymbol = Symbol("Hash");

export type MasterSeed = Uint8Array & { readonly [masterSeedSymbol]: true };
export type DerivationSeed = Uint8Array & {
  readonly [derivationSeedSymbol]: true;
};
export type PublicKey = Uint8Array & { readonly [publicKeySymbol]: true };
export type PrivateKey = Uint8Array & { readonly [privateKeySymbol]: true };
export type HostSpecificKeyPair = KeyPair & {
  readonly [hostSpecificKeyPairSymbol]: true;
};
export type Hash = Uint8Array & { readonly [hashSymbol]: true };

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
  blake3: (data: Uint8Array) => Promise<Hash>;
}

export interface IMsgpackCodec {
  encode: (source: unknown) => Uint8Array;
  decode: (packed: ArrayBuffer | Uint8Array) => unknown;
  decodeAsync: (stream: ReadableStream<Uint8Array>) => Promise<unknown>;
}

export interface IProtoHost {
  storage: IStorage;
  crypto: IHostCrypto;
  notifier: IPushNotifier;
  clock: IClock;
}

export type PushReceiver = (data: Uint8Array) => void;
export interface IPushOpenResponse {
  send: (data: Uint8Array) => Status;
  shut: () => Status;
  status: Status;
}
export interface IPushNotifier {
  open(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    crypto: IHostCrypto,
    clock: IClock,
  ): Promise<IPushOpenResponse>;
  push(pubKey: PublicKey, data: Uint8Array): void;
}
export interface IWebSocketPushNotifier extends IPushNotifier {
  handle(host: IProtoHost, req: Request): Promise<Response>;
}
export interface IPushListener {
  connect(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    onDisconnect: () => void,
  ): Promise<Status>;
  connected(): boolean;
  disconnect(): void;
}

export interface IBagHeader {
  sig: Uint8Array;
  kdm: Uint8Array;
  lenHeadCph: number;
  lenBodyCph: number;
}

export interface IBag extends IBagHeader {
  headCph: Uint8Array;
  bodyCph: Uint8Array;
}

export type EncodedBag = Uint8Array;

// For HTTP model, the host handle is a URL.
// For LPC (local procedure call), it's a host instance.
export type HostHandle = URL | IProtoHost;

export interface IHostConnectionInfo<Handle extends HostHandle> {
  handle: Handle;
  label: string;
  idx: number;
}

export interface ITransport {
  call: (name: APICallName, enc: Encoder) => Promise<Decoder>;
  listener: IPushListener;
}
