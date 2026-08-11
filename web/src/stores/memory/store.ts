import { HostHandle, ICrypto } from "../../shared/types";
import { IStore } from "../../types";
import { MemoryDownloadQueue } from "./dnlds";
import { MemoryHostStore } from "./hosts";
import { MemoryMessageStore } from "./msgs";
import { MemorySeedStore } from "./seed";
import { MemoryUploadQueue } from "./uplds";

export class MemoryStore<Handle extends HostHandle> implements IStore<Handle> {
  seed: MemorySeedStore;
  hosts = new MemoryHostStore<Handle>();
  uploads = new MemoryUploadQueue();
  downloads = new MemoryDownloadQueue();
  messages: MemoryMessageStore;

  constructor(crypto: ICrypto) {
    this.seed = new MemorySeedStore(crypto);
    this.messages = new MemoryMessageStore(crypto);
  }

  async wipe() {
    // Protocol data only; seed wiped only via seed.wipe when client asks.
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}
