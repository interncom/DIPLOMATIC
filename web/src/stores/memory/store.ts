import { HostHandle } from "../../shared/types";
import { IStore } from "../../types";
import { MemoryDownloadQueue } from "./dnlds";
import { MemoryHostStore } from "./hosts";
import { MemoryMessageStore } from "./msgs";
import { MemorySeedStore } from "./seed"
import { MemoryUploadQueue } from "./uplds";

export class MemoryStore<Handle extends HostHandle> implements IStore<Handle> {
  seed = new MemorySeedStore();
  hosts = new MemoryHostStore<Handle>();
  uploads = new MemoryUploadQueue();
  downloads = new MemoryDownloadQueue();
  messages = new MemoryMessageStore();

  async init() {
    await this.seed.init();
    await this.hosts.init();
    await this.uploads.init();
    await this.downloads.init();
    await this.messages.init();
  }
}
