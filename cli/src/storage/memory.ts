import type { IStorage } from "../types.ts";

const memStorage: IStorage = {
  users: new Set<string>(), // Set of user pubkeys in hex.
  ops: new Map(), // Path => op binary.
}

export default memStorage;
