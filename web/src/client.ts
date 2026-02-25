import { encode } from "@msgpack/msgpack";
import libsodiumCrypto from "./crypto";
import { StateEmitter } from "./events";
import DiplomaticClientAPI from "./shared/client";
import { IClock } from "./shared/clock";
import { Decoder, Encoder } from "./shared/codec";
import { messageHeadCodec } from "./shared/codecs/messageHead";
import { EncodedMessage, genInsertHead, genUpsertHead } from "./shared/message";
import {
  EntityID,
  Hash,
  HostHandle,
  ICrypto,
  IHostConnectionInfo,
  IInsertParams,
  IMessage,
  IMessageHead,
  IMsgEntBody,
  ITransport,
  IUpsertParams,
  MasterSeed,
} from "./shared/types";
import { openBagBody } from "./shared/bag";
import { decryptPeekItem, syncPeek, syncPull, syncPush } from "./sync";
import {
  IClient,
  IDiplomaticClientState,
  IDiplomaticClientXferState,
  IDownloadMessage,
  IMsgParts,
  IStateEmitter,
  IStateManager,
  IStore,
  IStoredMessageData,
} from "./types";
import { Status } from "./shared/consts";
import { decodeFile, defaultFileExtension, encodeFile } from "./shared/exim";
import { saveAs } from "file-saver";
import { err, ok, ValStat } from "./shared/valstat";
import { eidCodec, makeEID } from "./shared/codecs/eid";
import { notifItemCodec } from "./shared/codecs/notifItem";
import { btob64 } from "./shared/binary";

export class SyncClient<Handle extends HostHandle> implements IClient<Handle> {
  connections = new Map<string, DiplomaticClientAPI<Handle>>();

  public clientState: IStateEmitter<IDiplomaticClientState>;
  public xferState: IStateEmitter<IDiplomaticClientXferState>;

  constructor(
    private clock: IClock,
    private state: IStateManager,
    private store: IStore<Handle>,
    private transport: ITransport,
    private crypto: ICrypto = libsodiumCrypto,
    // Client can be set to always force skew handling, to hide the pain.
    private forceSkewHandlingByDefault = true,
  ) {

    this.clientState = new StateEmitter(() => this.getClientState());

    this.xferState = new StateEmitter(() => this.getXferState());

  }

  private readonly SYNC_DEBOUNCE_DELAY_MS = 100;

  private syncTimeout: ReturnType<typeof setTimeout> | null = null;

  public async setSeed(seed: MasterSeed) {
    await this.store.seed.save(seed);
    this.clientState.emit();
  }

  private async getClientState(): Promise<IDiplomaticClientState> {
    const { store } = this;
    const enclave = await store.seed.load();
    const hosts = await store.hosts.list();
    return {
      hasSeed: enclave !== undefined,
      hasHost: Array.from(hosts).length > 0,
      connected: false, // TODO
    };
  }

  private async getXferState(): Promise<IDiplomaticClientXferState> {
    const { uploads, downloads } = this.store;
    const numUploads = await uploads.count();
    const numDownloads = await downloads.count();
    return { numDownloads, numUploads };
  }

  private apply = async (
    parts: IMsgParts[],
    upload = true,
  ): Promise<Status[]> => {
    const hashes: Hash[] = [];
    const storables: { key: Hash, data: IStoredMessageData }[] = [];
    const msgs: IMessage[] = [];

    // Process parts into:
    // 1. hashes for upload queueing,
    // 2. storables for message archive,
    // 3. msgs for application to state.
    // console.time("apply: processing parts...")
    for (const { head, body } of parts) {
      const enc = new Encoder();
      enc.writeStruct(messageHeadCodec, head);
      const headEnc = enc.result();
      const hash = await this.crypto.blake3(headEnc);
      const data: IStoredMessageData = {
        eid: head.eid,
        ...(head.off !== 0 ? { off: head.off } : {}),
        ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
        body
      };
      hashes.push(hash);
      storables.push({ key: hash, data });
      msgs.push({ ...head, bod: body });
    }
    // console.timeEnd("apply: processing parts...")

    // If message is being applied via sync, don't upload.
    if (upload) {
      // NOTE: important to enqueue upload before storing it.
      const hosts = await this.store.hosts.list();
      for (const host of hosts) {
        await this.store.uploads.enq(host.label, hashes);
      }
      // Clear any existing timeout to reset debounce
      if (this.syncTimeout !== null) {
        clearTimeout(this.syncTimeout);
      }
      // Schedule a new debounced sync call
      this.syncTimeout = setTimeout(async () => {
        this.syncTimeout = null;
        try {
          console.info("Syncing due to upload")
          await this.sync();
        } catch (err) {
          console.error('Debounced sync failed:', err);
        }
      }, this.SYNC_DEBOUNCE_DELAY_MS);
    }

    // console.time("apply: storing messages...")
    await this.store.messages.add(storables);
    // console.timeEnd("apply: storing messages...")

    // TODO: decide what should happen if there's an error while applying.
    // Dequeue upload and remove message?
    // console.time("apply: applying state updates...")
    const stats = await this.state.apply(msgs);
    // console.timeEnd("apply: applying state updates...")
    return stats;
  };

  public async insertRaw(bod: EncodedMessage) {
    const { clock, crypto } = this;
    const [head, stat] = await genInsertHead({ now: clock.now(), bod, crypto });
    if (stat !== Status.Success) {
      return err<IMessageHead>(stat);
    }
    await this.apply([{ head, body: bod }]);
    return ok(head);
  }

  public async upsertRaw(
    eid: EntityID,
    bod: EncodedMessage | undefined,
    force = false,
  ): Promise<ValStat<IMessageHead>> {
    const { clock, crypto, store } = this;
    const now = clock.now();
    const last = await store.messages.last(eid);
    if (last) {
      const decEid = new Decoder(eid);
      const [eidDec, statEid] = decEid.readStruct(eidCodec);
      if (statEid !== Status.Success) {
        return err<IMessageHead>(statEid);
      }

      const ts = eidDec.ts.getTime() + last.head.off;
      if (ts > now.getTime()) {
        // last was created in the future. So either:
        // a) another client's clock is skewed into the future, or
        // b) this client's clock is skewed into the past.

        if (force === false) {
          return err<IMessageHead>(Status.ClockOutOfSync);
        }

        // We need to recover from skew.
        // We do so by deleting the invalid entity and replacing it.
        // To overwrite the skewed entity, the delete must increment off,
        // even if that places the delete into the future as well.
        const offDel = last.head.off + 1;
        const offCtr = last.head.ctr + 1;
        const delHead = { eid, off: offDel, ctr: offCtr, len: 0 };
        const statsDel = await this.apply([{ head: delHead, body: undefined }]);
        const statDel = statsDel[0];
        if (statDel !== Status.Success) {
          return err<IMessageHead>(statDel);
        }

        if (bod === undefined) {
          // This upsert was a delete.
          // Therefore, we're done.
          // There's no replacement left to insert.
          return ok(delHead);
        }

        // Replace with a new msg that retains the old eid but clk of now.
        const [replEID, statReplEID] = makeEID({ id: eidDec.id, ts: now });
        if (statReplEID !== Status.Success) {
          return err<IMessageHead>(statReplEID);
        }
        const replParams = { now, eid: replEID, ctr: 0, bod, crypto };
        const [repl, statRepl] = await genUpsertHead(replParams);
        if (statRepl !== Status.Success) {
          return err<IMessageHead>(statRepl);
        }
        const statsApply = await this.apply([{ head: repl, body: bod }]);
        const statApply = statsApply[0];
        if (statApply !== Status.Success) {
          return err<IMessageHead>(statApply);
        }
        return ok(repl);
      }
    }
    const ctr = (last?.head.ctr ?? -1) + 1;
    const [msg, statMsg] = await genUpsertHead({ now, eid, ctr, bod, crypto });
    if (statMsg !== Status.Success) {
      return err<IMessageHead>(statMsg);
    }
    const statsApply = await this.apply([{ head: msg, body: bod }]);
    const statApply = statsApply[0];
    if (statApply !== Status.Success) {
      return err<IMessageHead>(statApply);
    }
    return ok(msg);
  }

  public async insert<T = unknown>(op: IInsertParams<T>) {
    const { body, type, gid, pid } = op;
    const entBody: IMsgEntBody = { body, type, gid, pid };
    const entBodyEnc = encode(entBody);
    return this.insertRaw(entBodyEnc);
  }

  public async upsert<T = unknown>(
    op: IUpsertParams<T>,
    force = this.forceSkewHandlingByDefault,
  ) {
    const { eid, body, type, gid, pid } = op;
    if (eid === undefined) {
      return this.insert(op);
    }
    const entBody: IMsgEntBody = { body, type, gid, pid };
    const entBodyEnc = encode(entBody);
    return this.upsertRaw(eid, entBodyEnc, force);
  }

  public async delete(eid: EntityID) {
    // NOTE: force (clock-skew handling) is set to true here.
    // When deleting, there's no reason not to force skew handling.
    return this.upsertRaw(eid, undefined, true);
  }

  public async genEID(id?: Uint8Array): Promise<ValStat<EntityID>> {
    const { clock, crypto } = this;
    const ts = clock.now();
    if (id !== undefined) {
      return makeEID({ id, ts });
    }
    const randId = await crypto.genRandomBytes(8);
    return makeEID({ id: randId, ts });
  }

  public async sync() {
    const { clock, connections, crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return Status.MissingSeed;
    }

    for (const [label, conn] of connections) {
      const host = await store.hosts.get(label);
      if (!host) {
        continue;
      }
      const peekStat = await syncPeek(
        conn,
        store,
        enclave,
        clock,
        host,
        crypto,
      );
      if (peekStat !== Status.Success) {
        console.error(`Failed to peek: ${peekStat}`);
        return peekStat;
      }
      const pushStat = await syncPush(
        conn,
        store,
        enclave,
        clock,
        host,
        crypto,
      );
      if (pushStat !== Status.Success) {
        console.error(`Failed to push: ${pushStat}`);
        return pushStat;
      }
      const pullStat = await syncPull(
        conn,
        store,
        enclave,
        host,
        crypto,
        this.apply.bind(this),
      );
      if (pullStat !== Status.Success && pullStat !== Status.NoChange) {
        console.error(`Failed to pull: ${pullStat}`);
        return pullStat;
      }
    }
    return Status.Success;
  }

  public async wipe() {
    await this.disconnect();
    await this.store.wipe();
    this.clientState.emit();
    this.xferState.emit();
  }

  public import = async (file: File, options?: { onProgress?: (index: number, total: number, status: Status) => void }): Promise<Status> => {
    const { crypto, store } = this;
    const onProgress = options?.onProgress;
    const enclave = await store.seed.load();
    if (!enclave) return Status.MissingSeed;

    // console.time("import: decoding file...");
    const bytes = await file.bytes();
    const [msgs, statDec] = await decodeFile(bytes, crypto, enclave);
    if (statDec !== Status.Success) return statDec;
    // console.timeEnd("import: decoding file...");

    let processed = 0;
    while (processed < msgs.length) {
      let totalBytes = 0;
      let count = 0;
      let end = processed;
      for (let i = processed; i < msgs.length && count < 1000 && totalBytes < 500 * 1024; i++) {
        totalBytes += msgs[i].head.len;
        count++;
        end = i + 1;
      }
      const batch = msgs.slice(processed, end);
      // console.time(`import: applying [${processed}, ${end}]`)
      const statsBatch = await this.apply(batch, false);
      // console.timeEnd(`import: applying [${processed}, ${end}]`)
      for (let i = 0; i < batch.length; i++) {
        const stat = statsBatch[i];
        if (stat !== Status.Success && stat !== Status.NoChange) {
          console.warn(`failed to import msg ${processed + i}: ${Status[stat]}`);
        }
      }
      if (onProgress) {
        queueMicrotask(() => onProgress(end, msgs.length, Status.Success));
      }
      processed = end;
    }

    // TODO: return the array of statuses for each import msg.
    return Status.Success;
  }

  public async export(filename: string, extension = defaultFileExtension) {
    const { crypto, store } = this;
    const enclave = await store.seed.load();
    if (!enclave) return Status.MissingSeed;

    const msgs = await store.messages.list();
    const [bytes, stat] = await encodeFile("export", 0, msgs, crypto, enclave);
    if (stat !== Status.Success) return stat;

    const blob = new Blob([bytes.slice()]);
    saveAs(blob, filename);
    return Status.Success;
  }

  // Manage stored host connections.
  public async link(host: IHostConnectionInfo<Handle>) {
    return this.store.hosts.add(host);
  }
  public async unlink(label: string) {
    return this.store.hosts.del(label);
  }

  // Manage active host connections.
  public async connect(listen = true) {
    const { clock, crypto, store, transport } = this;
    const enclave = await store.seed.load();
    if (!enclave) {
      return;
    }
    const hosts = await store.hosts.list();
    for (const host of hosts) {
      const { label } = host;
      if (this.connections.has(label)) {
        continue;
      }
      console.info(`Connecting to ${host.handle} (${label})`);
      const conn = new DiplomaticClientAPI(
        enclave,
        libsodiumCrypto,
        host,
        clock,
        transport,
        (meta) => this.store.hosts.set(label, meta),
      );
      await conn.register();
      if (listen) {
        const keys = await conn.keys();
        const recv = async (bytes: Uint8Array) => {
          const dec = new Decoder(bytes);
          const [item, s1] = dec.readStruct(notifItemCodec);
          if (s1 !== Status.Success) {
            console.error("Failed decoding notif", Status[s1]);
            return;
          }
          const [itemDec, s2] = await decryptPeekItem({ seq: item.seq, headCph: item.headCph }, keys, enclave, crypto);
          if (s2 !== Status.Success) {
            console.error("Failed decrypting notif", Status[s2]);
            return;
          }
          const headEncHash = await crypto.blake3(itemDec.headEnc);
          if (await store.messages.has(headEncHash)) {
            const headEncHashB64 = btob64(headEncHash);
            console.info("Already have message", headEncHashB64);
            return;
          }

          // Fall back to full sync if this is not the next bag seq we expect.
          const currHost = await store.hosts.get(label);
          if (!currHost || item.seq !== currHost.lastSeq + 1) {
            this.sync().catch((err) => console.error("Sync failed:", err));
            return;
          }

          // Bag is the next in sequence, so we can process it incrementally.
          // Meaning, we don't need to do a full sync.

          // Parse head.
          const headDec = new Decoder(itemDec.headEnc);
          const [head, headStatus] = headDec.readStruct(messageHeadCodec);
          if (headStatus !== Status.Success) {
            console.error("Failed to parse head", Status[headStatus]);
            return;
          }

          // Read body (if inline) or fetch it.
          let bodyCph: Uint8Array;
          if (item.bodyCph) {
            // Use inline body.
            bodyCph = item.bodyCph;
          } else {
            // Pull the body.
            const dlm: IDownloadMessage = { seq: item.seq, host: label, kdm: itemDec.kdm, head };
            await store.downloads.enq([dlm]);
            const [result, stat] = await conn.pull([item.seq]);
            if (stat !== Status.Success) {
              console.error("Failed to pull", Status[stat]);
              return;
            }
            const pullResult = result[0];
            if (!pullResult) {
              console.error("No pull result");
              return;
            }
            bodyCph = pullResult.bodyCph;
            await store.downloads.deq(label, [item.seq]);
          }

          // Parse body.
          const key = await enclave.deriveFromKDM(itemDec.kdm);
          const [contents, status] = await openBagBody(itemDec.headEnc, bodyCph, key, crypto);
          if (status !== Status.Success) {
            console.error("Failed to open body", Status[status]);
            return;
          }

          // Store message.
          const body = contents.bod;
          const data: IStoredMessageData = {
            eid: head.eid,
            ...(head.off !== 0 ? { off: head.off } : {}),
            ...(head.ctr !== 0 ? { ctr: head.ctr } : {}),
            body
          };
          await store.messages.add([{ key: headEncHash, data }]);

          // Apply message.
          const stats = await this.apply([{ head, body }], false);
          const stat = stats[0];
          if (stat !== Status.Success && stat !== Status.NoChange) {
            console.error("ERR applying", Status[stat]);
          }

          // Bump sequence.
          await store.hosts.touch(label, item.seq);
        };

        await conn.listen(recv);
      }
      this.connections.set(host.label, conn);
    }
  }

  public async disconnect() {
    this.connections.clear();
  }
}
