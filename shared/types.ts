import { IClock } from "./clock.ts";
import { Decoder, Encoder } from "./codec.ts";
import { IAuthTimestamp } from "./codecs/authTimestamp.ts";
import type { IBagPeekItem } from "./codecs/peekItem.ts";
import { IUsageQuota } from "./codecs/usageQuota.ts";
import { APICallName, Status } from "./consts.ts";
import { ValStat } from "./valstat.ts";

export type GroupID = Uint8Array | string;
export type EntityID = Uint8Array;

export type SerializedContent = Uint8Array;

export interface IMessageHead {
  // eid will generally be a random identifier.
  eid: Uint8Array;

  // clk is the creation timestamp of the entity.
  clk: Date;

  // [eid, clk] combined form a unique identifier of an entity.
  // This reduces the length required for eid to distinguish entities.
  // They only need to be distinct within the millisecond of creation (clk).

  // off is the number of milliseconds since entity creation (clk).
  off: number;

  // ctr is the prior max(ctr) + 1 for messages updating this entity.
  ctr: number;

  // len is the number of bytes in the message body (0 for deletes).
  len: number;

  // hsh is the blake3 hash of the message body.
  hsh?: Uint8Array;
}

// IMessage is the atomic unit of data in DIPLOMATIC.
// A message contains the metadata necessary for clients to sort messages and
// apply them in-order, producing a global, eventually-consistent data state
// across the distributed system.
// The header of the message contains that metadata.
// The body of a message (bod) is contains application-specific information.
export interface IMessage extends IMessageHead {
  bod?: SerializedContent;
}

export interface IMessageWithHash extends IMessage {
  headHash: Hash;
}

// IOp is an update to application state.
// Each IOp is a complete overwrite of an "entity" specified by [eid, clk].
// It reuses the header information from a message to identify a specific
// entity, with created at timestamp (clk) and updated at timestamp (clk + off).
// An IOp additionally has type, gid, and pid fields for indexing the entity.
export interface IOp<T = unknown> extends Omit<IMessageHead, "len" | "hsh"> {
  // aid?: AppID // Optional app ID to distinguish data from different apps in same database? TODO: think this one through.
  gid?: GroupID; // Optional group ID to efficiently select a group of entities (will be indexed).
  pid?: EntityID; // Optional parent ID to support hierarchical structure.
  type: string;
  body?: T;
}

export type IInsertParams<T> = Omit<IOp<T>, "ts" | "ctr" | "eid">;
export type IUpsertParams<T> = IInsertParams<T> & {
  eid?: EntityID;
  clk?: Date;
};

export interface IStorage {
  addUser: (pubKey: PublicKey) => Promise<ValStat<void>>;
  hasUser: (pubKey: PublicKey) => Promise<ValStat<boolean>>;
  subMeta: (pubKey: PublicKey) => Promise<ValStat<ISubscriptionMetadata>>;
  setBag: (
    pubKey: PublicKey,
    bag: IBag,
  ) => Promise<ValStat<number>>;
  getBody: (
    pubKey: PublicKey,
    seq: number,
  ) => Promise<ValStat<Uint8Array | undefined>>;
  listHeads: (
    pubKey: PublicKey,
    minSeq: number,
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
}

export interface ICrypto extends IHostCrypto {
  genRandomBytes: (bytes: number) => Promise<Uint8Array>;
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

// About 30 bytes.
export interface ISubscriptionMetadata {
  // Duration of subscrption term in milliseconds.
  // 0 indicates an indefinite term (either lifetime or pay-as-you-go).
  term: number;

  // Milliseconds since start of term.
  elapsed: number;

  // "static" usage, i.e. storage.
  stat: IUsageQuota;

  // "dynamic" usage, i.e. time (bandwidth, CPU time, ...).
  dyn: IUsageQuota;
}
export const nullSubMeta: ISubscriptionMetadata = {
  term: 0,
  elapsed: 0,
  stat: { quota: 0 },
  dyn: { quota: 0 },
};

export interface IHostMetadata {
  subscription: ISubscriptionMetadata;
  clockOffset: number;
}

export interface ITransport {
  call: (name: APICallName, enc: Encoder) => Promise<ValStat<Decoder>>;
  listener: IPushListener;
}
