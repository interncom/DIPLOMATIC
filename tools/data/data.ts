// Pair into an app folder, then sync that folder with a host.

import { createReadStream, readFileSync } from "node:fs";
import readline from "node:readline";
import {
  decodeRing,
  type Disk,
  encodeRing,
  fidoDev,
  hostBundles,
  installPair,
  newPrfEntry,
  openDisk,
  openRing,
  parseLabel,
} from "@interncom/diplomatic/bun";
import {
  asDHKEReq,
  asDHKEResp,
  asSealedMasterKey,
  btoh,
  type BundleHost,
  Clock,
  crypto,
  DHKE_RESP_MIN,
  Enclave,
  entStateManager,
  hostHTTPTransport,
  htob,
  type IDiplomaticClientXferState,
  Status,
  SyncClient,
} from "@interncom/diplomatic/web";

let disk: Disk | undefined;

function die(msg: string): never {
  disk?.close();
  console.error(msg);
  process.exit(1);
}

function usage(code: number): never {
  console.error("Usage:");
  console.error(
    "  bun run tools/data/data.ts --host URL --app NAME [--non-resident]",
  );
  console.error(
    "  bun run tools/data/data.ts --host URL --app NAME accept [DHKEREQ_HEX]",
  );
  console.error("");
  console.error("  The data directory is NAME in the current directory.");
  console.error("  The first run pairs (paste DHKE), binds the YubiKey,");
  console.error("  then connects and syncs. A later run unlocks that key.");
  console.error("  accept: this device is the enroller. Type yes, print");
  console.error("  DHKEResp, then connect and sync.");
  process.exit(code);
}

type Opts = {
  host: URL;
  app: string;
  resident: boolean;
  accept: boolean;
  hex?: string;
};

function flags(argv: string[]): Opts {
  let host = "";
  let app = "";
  let resident = true;
  let accept = false;
  let hex: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--non-resident") {
      resident = false;
      continue;
    }
    if (arg === "--host") {
      const next = argv[++i];
      if (next === undefined) die("missing --host value");
      host = next;
      continue;
    }
    if (arg === "--app") {
      const next = argv[++i];
      if (next === undefined) die("missing --app value");
      app = next;
      continue;
    }
    if (arg === "accept") {
      accept = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") usage(0);
    if (accept && hex === undefined && !arg.startsWith("-")) {
      hex = arg;
      continue;
    }
    die(`unknown arg ${arg}`);
  }
  if (host === "") die("missing --host");
  if (app === "") die("missing --app");
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    die("bad host URL");
  }
  return { host: url, app: parseLabel(app), resident, accept, hex };
}

// readLine reads one stdin line. A prompt goes to stderr when stdin is a TTY.
async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  console.error(prompt);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return await new Promise<string>((resolve) => {
    rl.once("line", (l) => {
      rl.close();
      resolve(l.trim());
    });
  });
}

// readTtyLine reads the controlling TTY, not a pipe.
async function readTtyLine(prompt: string): Promise<string> {
  console.error(prompt);
  const tty = createReadStream("/dev/tty");
  const rl = readline.createInterface({ input: tty });
  try {
    return await new Promise<string>((resolve, reject) => {
      rl.once("line", (l) => resolve(l.trim()));
      tty.once("error", reject);
    });
  } catch {
    die("pair accept needs a TTY to confirm you control both devices");
  } finally {
    rl.close();
    tty.destroy();
  }
}

// ackBothSides is true only after the user types yes on the TTY.
async function ackBothSides(): Promise<true> {
  const line = await readTtyLine(
    "Confirm you control both devices in this pairing. Type yes:",
  );
  if (line.toLowerCase() !== "yes") {
    die("aborted (type yes if you control both devices)");
  }
  return true;
}

// openApp opens NAME/ and an ents-backed sync client. The disk stays open.
async function openApp(dir: string): Promise<SyncClient<URL>> {
  disk = openDisk(dir);
  const [ents, est] = await disk.openEnts("");
  if (est !== Status.Success || ents === undefined) {
    die(`opening ents: ${Status[est]}`);
  }
  return new SyncClient(
    new Clock(),
    entStateManager(ents),
    disk.store,
    hostHTTPTransport,
    crypto,
  );
}

// sealMaster seals with the enrollee enclave. sealWithIKM wipes ikm.
async function sealMaster(
  enclave: Enclave,
  ikm: Uint8Array,
): Promise<Uint8Array> {
  const [sealed, sst] = await enclave.sealWithIKM(ikm);
  if (sst !== Status.Success || sealed === undefined) die(`seal ${sst}`);
  return sealed;
}

// unsealMaster opens one CLI seal with this process's Enclave.
async function unsealMaster(
  sealed: Uint8Array,
  ikm: Uint8Array,
): Promise<Enclave | undefined> {
  const [sm, sst] = asSealedMasterKey(sealed);
  if (sst !== Status.Success || sm === undefined) {
    ikm.fill(0);
    return undefined;
  }
  const [enc, est] = await Enclave.unsealWithIKM(sm, ikm);
  if (est !== Status.Success || enc === undefined) return undefined;
  return enc;
}

async function unlock(): Promise<Enclave> {
  if (disk === undefined) die("disk is not open");
  const bytes = await disk.store.account.readKeyring("");
  if (bytes === undefined) die("no keyring stored");
  const ring = decodeRing(bytes);
  if (ring === undefined) die("bad keyring");
  const dev = fidoDev();
  console.error(`Using ${dev}`);
  return openRing(ring, dev, unsealMaster);
}

// pairRequest is the enrollee. The returned enclave is the paired master.
async function pairRequest(): Promise<
  { enclave: Enclave; hosts: BundleHost[] }
> {
  const [req, rst] = await Enclave.pairRequest();
  if (rst !== Status.Success || req === undefined) die(`pairRequest ${rst}`);
  const [pub, qst] = req.dhkeReq();
  if (qst !== Status.Success) {
    req.wipe();
    die(`dhkeReq ${qst}`);
  }
  console.error("DHKEReq (paste into the other device):");
  process.stdout.write(btoh(pub) + "\n");
  const raw = await readLine("Paste DHKEResp hex, then Enter.");
  const hex = raw.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < DHKE_RESP_MIN * 2) {
    req.wipe();
    die(`DHKEResp must be at least ${DHKE_RESP_MIN * 2} hex characters`);
  }
  const [dhkeResp, vst] = asDHKEResp(htob(hex));
  if (vst !== Status.Success || dhkeResp === undefined) {
    req.wipe();
    die(`DHKEResp ${vst}`);
  }
  const [opened, ost] = await req.finish(dhkeResp);
  if (ost !== Status.Success || opened === undefined) {
    die(`finish ${Status[ost]} (${ost})`);
  }
  return opened;
}

async function bindKey(app: string, enclave: Enclave, resident: boolean) {
  if (disk === undefined) die("disk is not open");
  const ring = await newPrfEntry(
    app,
    resident,
    (ikm) => sealMaster(enclave, ikm),
  );
  const wst = await disk.store.account.writeKeyring("", encodeRing(ring));
  if (wst !== Status.Success) die(`keyring ${Status[wst]} (${wst})`);
  console.error(`Wrote keyring in ${disk.dir}`);
}

// ensureHost links the flag host when no stored row already has that URL.
async function ensureHost(client: SyncClient<URL>, host: URL) {
  const rows = await client.hosts();
  for (const row of rows) {
    if (row.handle.href === host.href) return;
  }
  await client.link({ handle: host, label: "host", idx: 0 }, false);
}

const countDelayMs = 200;

// showSync rewrites phase, queue depths, and the local msg count on stderr.
function showSync(client: SyncClient<URL>) {
  let phase = "idle";
  let numUp = 0;
  let numDown = 0;
  let numLocal: number | undefined;
  let drawn = 0;
  let last = "";
  let heard = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let again = false;

  // Paint the four lines. A TTY rewrites them in place.
  const paint = () => {
    const local = numLocal === undefined ? "-" : String(numLocal);
    const next = [
      `phase ${phase}`,
      `upload queue ${numUp}`,
      `download queue ${numDown}`,
      `local ${local}`,
    ].join("\n");
    if (next === last) return;
    const lines = next.split("\n");
    const tty = process.stderr.isTTY === true;
    if (tty && drawn > 0) process.stderr.write(`\x1b[${drawn}A`);
    for (const line of lines) {
      if (tty) process.stderr.write(`\x1b[2K${line}\n`);
      else process.stderr.write(`${line}\n`);
    }
    drawn = lines.length;
    last = next;
  };

  // Reload the local count. A newer tick waits until this one finishes.
  const loadLocal = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        numLocal = await client.countMsgs();
        paint();
      } while (again);
    } finally {
      busy = false;
    }
  };

  // Schedule a local recount after transfer ticks settle.
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void loadLocal();
    }, countDelayMs);
  };

  // Take one transfer snapshot: phase plus the two queue depths.
  const onXfer = (s: IDiplomaticClientXferState) => {
    phase = s.progress.phase;
    numUp = s.numUploads;
    numDown = s.numDownloads;
    paint();
    schedule();
  };

  client.xferState.listen((s) => {
    heard = true;
    onXfer(s);
  });
  void client.xferState.get().then((s) => {
    if (!heard) onXfer(s);
  });
  void loadLocal();
}

// live connects every linked host and schedules a sync. The process stays up.
async function live(client: SyncClient<URL>, host: URL) {
  await ensureHost(client, host);
  showSync(client);
  await client.connect(true, true);
  process.stdin.resume();
}

async function runEnrollee(opts: Opts) {
  const client = await openApp(opts.app);
  if (disk === undefined) die("disk is not open");
  const held = await disk.store.account.readKeyring("");
  if (held === undefined) {
    const opened = await pairRequest();
    const ist = await installPair(client, opened, { persist: false });
    if (ist !== Status.Success) die(`install ${Status[ist]} (${ist})`);
    await bindKey(opts.app, opened.enclave, opts.resident);
  } else {
    console.error("Unlocking the stored key");
    const enc = await unlock();
    const sst = await client.setSeed(enc, { persist: false });
    if (sst !== Status.Success) die(`setSeed ${Status[sst]} (${sst})`);
  }
  await live(client, opts.host);
}

async function runAccept(opts: Opts) {
  let reqHex = opts.hex;
  if (reqHex === undefined) {
    reqHex = await readLine("Paste DHKEReq hex, then Enter.");
  }
  const hex = reqHex.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) die("DHKEReq must be 64 hex characters");
  const [dhkeReq, qst] = asDHKEReq(htob(hex));
  if (qst !== Status.Success || dhkeReq === undefined) die(`DHKEReq ${qst}`);
  const userControlsBothSidesOfPair = await ackBothSides();
  const client = await openApp(opts.app);
  const enc = await unlock();
  const sst = await client.setSeed(enc, { persist: false });
  if (sst !== Status.Success) die(`setSeed ${Status[sst]} (${sst})`);
  let hosts = hostBundles(await client.hosts());
  if (hosts.length === 0) {
    hosts = [{ handle: opts.host.href, label: "host", idx: 0 }];
  }
  const [resp, ast] = await enc.pairAccept(dhkeReq, hosts, {
    userControlsBothSidesOfPair,
  });
  if (ast !== Status.Success || resp === undefined) {
    die(`pairAccept ${Status[ast]} (${ast})`);
  }
  process.stdout.write(btoh(resp) + "\n");
  await live(client, opts.host);
}

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help") || argv.length === 0) {
  usage(argv.includes("-h") || argv.includes("--help") ? 0 : 1);
}
const opts = flags(argv);
if (opts.accept) {
  await runAccept(opts);
} else {
  await runEnrollee(opts);
}
