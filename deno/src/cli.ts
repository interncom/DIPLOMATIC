import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/enclave.ts";
import DiplomaticClientAPI from "../../shared/client.ts";
import {
  HostHandle,
  IBag,
  IHostConnectionInfo,
  IMessage,
  ITransport,
  MasterSeed,
} from "../../shared/types.ts";
import type { IBagPeekItem } from "../../shared/codecs/peekItem.ts";
import libsodiumCrypto from "./crypto.ts";
import { Clock } from "../../shared/clock.ts";
import { err, ok, ValStat } from "../../shared/valstat.ts";
import { IBagPushItem } from "../../shared/codecs/pushItem.ts";

// A CLIClient maintains no state.
export class CLIClient<Handle extends HostHandle> {
  private enclave: Enclave;
  private conn?: DiplomaticClientAPI<Handle>;

  constructor(seed: MasterSeed) {
    this.enclave = new Enclave(seed, libsodiumCrypto);
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
}

export async function initCLI<Handle extends HostHandle>(
  seed: MasterSeed,
  host: IHostConnectionInfo<Handle>,
  transport: ITransport,
): Promise<ValStat<CLIClient<Handle>>> {
  const cli = new CLIClient<Handle>(seed);
  const stat = await cli.connect(host, transport);
  if (stat !== Status.Success) {
    return err(stat);
  }
  return ok(cli);
}
