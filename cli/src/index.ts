import { IOpenBag, openBagBody } from "../../shared/bag.ts";
import { htob } from "../../shared/binary.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import { Clock, IClock } from "../../shared/clock.ts";
import type { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
import { IBagPullItem } from "../../shared/codecs/pullItem.ts";
import { IBagPushItem } from "../../shared/codecs/pushItem.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/enclave.ts";
import { genSingletonUpsert } from "../../shared/message.ts";
import { decryptPeekItem } from "../../shared/sync.ts";
import {
  HostHandle,
  IBag,
  IHostConnectionInfo,
  IMessage,
  ITransport,
  MasterSeed,
} from "../../shared/types.ts";
import { err, ok, ValStat } from "../../shared/valstat.ts";
import libsodiumCrypto from "../../deno/src/crypto.ts";

// A CLIClient maintains no state.
export class CLIClient<Handle extends HostHandle> {
  private enclave: Enclave;
  private conn?: DiplomaticClientAPI<Handle>;
  private clock: IClock;

  constructor(
    { seed, clock = new Clock() }: { seed: MasterSeed; clock?: IClock },
  ) {
    this.enclave = new Enclave(seed, libsodiumCrypto);
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
      libsodiumCrypto,
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

    const hostKeys = await this.conn.keys();
    const [itemDec, statPeekItem] = await decryptPeekItem(
      peekItem,
      hostKeys,
      this.enclave,
      libsodiumCrypto,
    );
    if (statPeekItem !== Status.Success) return err(statPeekItem);

    const key = await this.enclave.deriveFromKDM(itemDec.kdm);
    return openBagBody(itemDec.headEnc, pullItem.bodyCph, key, libsodiumCrypto);
  }

  async upsertSingletonSync(type: string, body: Uint8Array): Promise<Status> {
    const [msg, statMsg] = await genSingletonUpsert(type, this.clock, body);
    if (statMsg !== Status.Success) return statMsg;
    const [, statPush] = await this.push([msg]);
    return statPush;
  }
}

export async function initCLI<Handle extends HostHandle>(
  seed: MasterSeed,
  host: IHostConnectionInfo<Handle>,
  transport: ITransport,
): Promise<[CLIClient<Handle>, Status]> {
  const cli = new CLIClient<Handle>({ seed });
  const stat = await cli.connect(host, transport);
  return [cli, stat];
}

export async function initCLIOrPanic<Handle extends HostHandle>(
  seed: MasterSeed,
  host: IHostConnectionInfo<Handle>,
  transport: (host: IHostConnectionInfo<Handle>) => ITransport,
): Promise<CLIClient<Handle>> {
  const cli = new CLIClient<Handle>({ seed });
  const stat = await cli.connect(host, transport(host));
  if (stat !== Status.Success) panic("Failed to initialize CLI");
  return cli;
}

export function panic(msg: string) {
  console.error(msg);
  Deno.exit(1);
}

export function loadSeedOrPanic(envVar: string): MasterSeed {
  const seedHex = Deno.env.get(`${envVar}`);
  if (!seedHex) panic(`${envVar} env var missing`);
  const seed = htob(seedHex!);
  if (seed.length !== 32) panic(`${envVar} must be 64 hex chars (32 bytes)`);
  return seed as MasterSeed;
}

export function loadHostOrPanic(envVar: string): IHostConnectionInfo<URL> {
  const hostURL = Deno.env.get(`${envVar}`);
  if (!hostURL) panic(`${envVar} env var missing`);
  return {
    handle: new URL(hostURL!),
    label: "host",
  };
}

// Re-exports for convenience in demos
export { default as denoMsgpack } from "../../deno/src/codec.ts";
export { Status } from "../../shared/consts.ts";
export { hostHTTPTransport } from "../../shared/http.ts";