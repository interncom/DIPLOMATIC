import { HostHandle, ICrypto } from "../../shared/types";
import { IStore } from "../../types";
import { MemoryDownloadQueue } from "./dnlds";
import { MemoryHostStore } from "./hosts";
import { MemoryMessageStore } from "./msgs";
import { MemoryAccountStore } from "./account";
import { MemoryUploadQueue } from "./uplds";

export class MemoryStore<Handle extends HostHandle> implements IStore<Handle> {
  account: MemoryAccountStore;
  hosts = new MemoryHostStore<Handle>();
  uploads = new MemoryUploadQueue();
  downloads = new MemoryDownloadQueue();
  messages: MemoryMessageStore;

  constructor(crypto: ICrypto) {
    this.account = new MemoryAccountStore(crypto);
    this.messages = new MemoryMessageStore(crypto);
  }

  async wipe() {
    // Protocol data only; account wiped only via account.wipe when client asks.
    await this.hosts.wipe();
    await this.uploads.wipe();
    await this.downloads.wipe();
    await this.messages.wipe();
  }
}
