import { IOpenBag, openBagBody } from "../../shared/bag.ts";
import { htob } from "../../shared/binary.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Clock, IClock } from "../../shared/clock.ts";
import type { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
import { IBagPullItem } from "../../shared/codecs/pullItem.ts";
import { IBagPushItem } from "../../shared/codecs/pushItem.ts";
import { Status } from "../../shared/consts.ts";
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
    this.conn = new DiplomaticClientAPI<Handle>(
      this.enclave,
      crypto,
      host,
      clock,
      transport,
      updateHostMeta,
    );
    const [, stat] = await this.conn.register();
    return stat;
  }

  async push(msgs: IMessage[]): Promise<ValStat<IBagPushItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }

    const bags: IBag[] = [];
    for (const msg of msgs) {
      const [bag, statBag] = await this.conn.seal(msg);
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

  async peek(lastSeq: number): Promise<ValStat<IBagPeekItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }

    return this.conn.peek(lastSeq);
  }

  async pull(seqs: number[]): Promise<ValStat<IBagPullItem[]>> {
    if (!this.conn) {
      return err(Status.ConnectionClosed);
    }

    return this.conn.pull(seqs);
  }

  async open(
    peekItem: IBagPeekItem,
    pullItem: IBagPullItem,
  ): Promise<ValStat<IOpenBag>> {
    if (!this.conn) return err(Status.ConnectionClosed);

    const hostIdnt = await this.conn.identity();
    const [itemDec, statPeekItem] = await decryptPeekItem(
      peekItem,
      hostIdnt.publicKey,
      this.enclave,
      crypto,
    );
    if (statPeekItem !== Status.Success) return err(statPeekItem);

    const cipher = this.enclave.deriveCipher(itemDec.kdm, "decrypt");
    return openBagBody(itemDec.headEnc, pullItem.bodyCph, cipher, crypto);
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
