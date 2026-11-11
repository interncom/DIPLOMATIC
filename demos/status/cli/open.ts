// Opens the status app on the disk store. The seed stays in the environment.

import { type Disk, openDisk } from "../../../bun/src/client/open.ts";
import { htob } from "../../../web/src/shared/binary.ts";
import { Clock } from "../../../web/src/shared/clock.ts";
import { Status } from "../../../web/src/shared/consts.ts";
import { Enclave } from "../../../web/src/shared/crypto/enclave.ts";
import { noble as crypto } from "../../../web/src/shared/crypto/noble.ts";
import { hostHTTPTransport } from "../../../web/src/shared/http.ts";
import type { IHostConnectionInfo } from "../../../web/src/shared/types.ts";
import { SyncClient } from "../../../web/src/client.ts";
import type { IEntDB } from "../../../web/src/entdb/entdb.ts";
import { entStateManager } from "../../../web/src/entdb/manager.ts";
import type { StateManager } from "../../../web/src/state.ts";

const statusType = "status";

function panic(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// loadEnclave reads a 32-byte master seed hex from envVar.
function loadEnclave(envVar: string): Enclave {
  const seedHex = process.env[envVar];
  if (!seedHex) panic(`${envVar} env var missing`);
  const bytes = htob(seedHex);
  const [enclave, st] = Enclave.fromBytes(bytes);
  bytes.fill(0);
  if (st !== Status.Success || enclave === undefined) {
    panic(`${envVar} must be 64 hex chars (32-byte master seed)`);
  }
  return enclave;
}

// loadHost reads a host URL from envVar. The label is "host".
function loadHost(envVar: string): IHostConnectionInfo<URL> {
  const hostURL = process.env[envVar];
  if (!hostURL) panic(`${envVar} env var missing`);
  return { handle: new URL(hostURL), label: "host" };
}

export type StatusApp = {
  client: SyncClient<URL>;
  disk: Disk;
  state: StateManager;
  ents: IEntDB;
};

// openStatus opens DIP_DIR (default .status), then the default account.
export async function openStatus(): Promise<StatusApp> {
  const dir = process.env.DIP_DIR !== undefined && process.env.DIP_DIR !== ""
    ? process.env.DIP_DIR
    : ".status";
  const enclave = loadEnclave("DIP_SEED");
  const host = loadHost("DIP_HOST");
  const disk = openDisk(dir);
  const [ents, est] = await disk.openEnts("");
  if (est !== Status.Success || ents === undefined) {
    disk.close();
    panic(`opening ents: ${Status[est]}`);
  }
  const state = entStateManager(ents);
  const client = new SyncClient(
    new Clock(),
    state,
    disk.store,
    hostHTTPTransport,
    crypto,
  );
  const sst = await client.setSeed(enclave);
  if (sst !== Status.Success) {
    disk.close();
    panic(`setSeed: ${Status[sst]}`);
  }
  await client.link(host, false);
  return { client, disk, state, ents };
}

// latestStatus is the newest status ent body, as text.
export async function latestStatus(edb: IEntDB): Promise<string | undefined> {
  const [ents, st] = await edb.getEntities<Uint8Array>({ type: statusType });
  if (st !== Status.Success || ents === undefined || ents.length === 0) {
    return undefined;
  }
  let best = ents[0];
  if (best === undefined) return undefined;
  for (const ent of ents) {
    if (ent.updatedAt > best.updatedAt) best = ent;
  }
  if (!(best.body instanceof Uint8Array)) return undefined;
  return new TextDecoder().decode(best.body);
}

export { statusType };
