// Installs a finished DHKE pair: key tag, then host rows when none are stored.

import { Status } from "../../../web/src/shared/consts.ts";
import type { BundleHost } from "../../../web/src/shared/codecs/bundleHost.ts";
import type { Enclave } from "../../../web/src/shared/crypto/enclave.ts";
import type { IHostConnectionInfo } from "../../../web/src/shared/types.ts";
import type { IHostRow, SetSeedOpts } from "../../../web/src/types.ts";

// PairClient is the setSeed, hosts, and link surface installPair uses.
type PairClient = {
  setSeed(enclave: Enclave, opts?: SetSeedOpts): Promise<Status>;
  hosts(): Promise<IHostRow<URL>[]>;
  link(host: IHostConnectionInfo<URL>, connect?: boolean): Promise<unknown>;
};

// hostBundles are the host rows sealed into a pair response.
export function hostBundles(rows: IHostRow<URL>[]): BundleHost[] {
  return rows.map((h) => ({
    handle: String(h.handle),
    label: h.label,
    idx: h.idx ?? 0,
  }));
}

// installPair records the key tag, then links hosts when the account has none.
// connect is false: the caller decides when to open a socket.
export async function installPair(
  client: PairClient,
  opened: { enclave: Enclave; hosts: BundleHost[] },
  opts?: SetSeedOpts,
): Promise<Status> {
  const st = await client.setSeed(opened.enclave, opts);
  if (st !== Status.Success) return st;
  const existing = await client.hosts();
  if (existing.length > 0 || opened.hosts.length === 0) return Status.Success;

  // Parse every handle before linking any of them.
  const links: { handle: URL; label: string; idx?: number }[] = [];
  for (const h of opened.hosts) {
    let handle: URL;
    try {
      handle = new URL(h.handle);
    } catch {
      return Status.InvalidParam;
    }
    links.push({ handle, label: h.label, idx: h.idx });
  }
  for (const host of links) {
    await client.link(host, false);
  }
  return Status.Success;
}
