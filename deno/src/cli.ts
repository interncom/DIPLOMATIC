import { IOpenBag, openBagBody } from "../../shared/bag.ts";
import { htob } from "../../shared/binary.ts";
import DiplomaticClientAPI, { hostBagMgrs } from "../../shared/client.ts";
import { Clock, IClock } from "../../shared/clock.ts";
import type { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
import { IBagPullItem } from "../../shared/codecs/pullItem.ts";
import { IBagPushItem } from "../../shared/codecs/pushItem.ts";
import type { IKDM } from "../../shared/codecs/kdm.ts";
import { Status } from "../../shared/consts.ts";
import { nullKDM } from "../../shared/crypto/derivation.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { genSingletonUpsert } from "../../shared/singleton.ts";
import { decryptPeekItem } from "../../shared/sync.ts";
import {
  HostHandle,
  IBag,
  IHostConnectionInfo,
  IMessage,
  ITransport,
} from "../../shared/types.ts";
import { err, ok, ValStat } from "../../shared/valstat.ts";
import crypto from "./crypto.ts";

// A CLIClient maintains no state. Master seed lives only inside the Enclave.
export class CLIClient<Handle extends HostHandle> {
  private enclave: Enclave;
  private conn?: DiplomaticClientAPI<Handle>;
  private clock: IClock;

  constructor(
    { enclave, clock = new Clock() }: { enclave: Enclave; clock?: IClock },
  ) {
    this.enclave = enclave;
    this.clock = clock;
  }

  async connect(
    host: IHostConnectionInfo<Handle>,
    transport: ITransport,
  ): Promise<Status> {
    const clock = new Clock();
    const updateHostMeta = () => Promise.resolve(Status.Success);
    const [bagMgrs, mst] = await hostBagMgrs(this.enclave, {
      label: host.label,
      index: host.idx ?? 0,
    });
    if (mst !== Status.Success) return mst;
    this.conn = new DiplomaticClientAPI<Handle>(
      bagMgrs,
      crypto,
      clock,
      transport,
      updateHostMeta,
    );
    const [, stat] = await this.conn.register();
    return stat;
  }

  async push(
    msgs: IMessage[],
    realm?: IKDM,
  ): Promise<ValStat<IBagPushItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }
    const stRealm = await this.#realm(realm);
    if (stRealm !== Status.Success) return err(stRealm);

    const bags: IBag[] = [];
    for (const msg of msgs) {
      const [bag, statBag] = await this.conn.seal(msg, realm);
      if (statBag !== Status.Success) {
        return err(statBag);
      }
      bags.push(bag);
    }

    const [items, statPush] = await this.conn.push(bags);
    if (statPush !== Status.Success) {
      return err(statPush);
    }

    return ok(items);
  }

  async peek(
    lastSeq: number,
    realm?: IKDM,
  ): Promise<ValStat<IBagPeekItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }
    const stRealm = await this.#realm(realm);
    if (stRealm !== Status.Success) return err(stRealm);

    return this.conn.peek(lastSeq, realm);
  }

  async pull(
    seqs: number[],
    realm?: IKDM,
  ): Promise<ValStat<IBagPullItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }
    const stRealm = await this.#realm(realm);
    if (stRealm !== Status.Success) return err(stRealm);

    return this.conn.pull(seqs, realm);
  }

  async open(
    peekItem: IBagPeekItem,
    pullItem: IBagPullItem,
    realm?: IKDM,
  ): Promise<ValStat<IOpenBag>> {
    if (!this.conn) return err(Status.ConnectionClosed);
    const stRealm = await this.#realm(realm);
    if (stRealm !== Status.Success) return err(stRealm);
    const bagMgr = this.conn.bagMgrFor(realm ?? nullKDM);
    if (bagMgr === undefined) return err(Status.NotFound);

    const [hostIdnt, ist] = await this.conn.identity();
    if (ist !== Status.Success) return err(ist);
    let verifyKey: CryptoKey;
    try {
      verifyKey = await crypto.importVerifyKey(hostIdnt.publicKey);
    } catch {
      return err(Status.CryptoError);
    }
    const [itemDec, statPeekItem] = await decryptPeekItem(
      peekItem,
      verifyKey,
      bagMgr,
      crypto,
    );
    if (statPeekItem !== Status.Success) return err(statPeekItem);

    return openBagBody(
      itemDec.headEnc,
      pullItem.bodyCph,
      { decrypt: (data) => bagMgr.decrypt(itemDec.kdm, data) },
      crypto,
    );
  }

  // Derives `realm` for this host unless the connection already has it.
  async #realm(realm: IKDM = nullKDM): Promise<Status> {
    const conn = this.conn;
    if (!conn) return Status.ConnectionClosed;
    if (conn.bagMgrFor(realm) !== undefined) return Status.Success;
    const [home, st] = await conn.identity();
    if (st !== Status.Success) return st;
    const [bagMgr, bst] = await this.enclave.bagman(home.idKDM, realm);
    if (bst !== Status.Success) return bst;
    conn.add(bagMgr);
    return Status.Success;
  }

  async upsertSingletonSync(type: string, body: Uint8Array): Promise<Status> {
    const [msg, statMsg] = await genSingletonUpsert(type, this.clock, body);
    if (statMsg !== Status.Success) return statMsg;
    const [, statPush] = await this.push([msg]);
    return statPush;
  }
}

export async function initCLI<Handle extends HostHandle>(
  enclave: Enclave,
  host: IHostConnectionInfo<Handle>,
  transport: ITransport | ((host: IHostConnectionInfo<Handle>) => ITransport),
): Promise<[CLIClient<Handle>, Status]> {
  const cli = new CLIClient<Handle>({ enclave });
  const t = typeof transport === "function" ? transport(host) : transport;
  const stat = await cli.connect(host, t);
  return [cli, stat];
}

export async function initCLIOrPanic<Handle extends HostHandle>(
  enclave: Enclave,
  host: IHostConnectionInfo<Handle>,
  transport: (host: IHostConnectionInfo<Handle>) => ITransport,
): Promise<CLIClient<Handle>> {
  const [cli, stat] = await initCLI(enclave, host, transport);
  if (stat !== Status.Success) panic("Failed to initialize CLI");
  return cli;
}

export function panic(msg: string) {
  console.error(msg);
  Deno.exit(1);
}

/** Load master seed hex from env and construct an Enclave immediately. */
export function loadEnclaveOrPanic(envVar: string): Enclave {
  const seedHex = Deno.env.get(`${envVar}`);
  if (!seedHex) panic(`${envVar} env var missing`);
  const bytes = htob(seedHex);
  const [enclave, st] = Enclave.fromBytes(bytes);
  bytes.fill(0);
  if (st !== Status.Success || enclave === undefined) {
    panic(`${envVar} must be 64 hex chars (32-byte master seed)`);
  }
  return enclave;
}

export function loadHostOrPanic(envVar: string): IHostConnectionInfo<URL> {
  const hostURL = Deno.env.get(`${envVar}`);
  if (!hostURL) panic(`${envVar} env var missing`);
  return {
    handle: new URL(hostURL),
    label: "host",
  };
}
