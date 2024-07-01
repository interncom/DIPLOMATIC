import type { IOp, IStorage } from "./shared/types";

export interface IQueue<K, V> {
  /**
   * Adds an entry to the queue.
   * @param key - The key of the entry.
   * @param value - The value of the entry.
   */
  enqueue(key: K, value: V): Promise<void>;

  /**
   * Returns the value of the entry with the specified key without removing it.
   * @param key - The key of the entry.
   * @returns The value of the entry if found, or undefined if the key does not exist.
   */
  peek(key: K): Promise<V | undefined>;

  /**
   * Returns an array of entries in the queue, allowing sorting and iteration over all entries.
   * @returns An array of entries in the queue.
   */
  entries(): Promise<Array<[K, V]>>;

  /**
   * Removes the entry with the specified key from the queue.
   * @param key - The key of the entry.
   * @returns The value of the removed entry if found, or undefined if the key does not exist.
   */
  dequeue(key: K): Promise<V | undefined>;

  /**
   * Returns the number of entries in the queue.
   * @returns The size of the queue.
   */
  size(): Promise<number>;
}

export interface IClientStateStore {
  init?: () => Promise<void>;
  getSeed: () => Promise<Uint8Array | undefined>;
  setSeed: (seed: Uint8Array) => Promise<void>;
  getHostURL: () => Promise<string | undefined>;
  setHostURL: (url: string) => Promise<void>;
  getHostID: () => Promise<string | undefined>;
  setHostID: (id: string) => Promise<void>;

  enqueueUpload: (sha256: string, cipherOp: Uint8Array) => Promise<void>;
  dequeueUpload: (sha256: string) => Promise<void>;
  peekUpload: (sha256: string) => Promise<Uint8Array | undefined>;
  listUploads: () => Promise<string[]>;

  enqueueDownload: (path: string) => Promise<void>;
  dequeueDownload: (path: string) => Promise<void>;
  listDownloads: () => Promise<string[]>;
}

export type DiplomaticClientState = "loading" | "seedless" | "hostless" | "ready";

export type Applier = (op: IOp) => Promise<void>;
