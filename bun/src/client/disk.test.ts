// Disk store: catalog, protocol file, ents file, and spilled bodies.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEID } from "../../../web/src/shared/codecs/eid.ts";
import { Clock } from "../../../web/src/shared/clock.ts";
import { Status } from "../../../web/src/shared/consts.ts";
import { Enclave } from "../../../web/src/shared/crypto/enclave.ts";
import { hostHTTPTransport } from "../../../web/src/shared/http.ts";
import type {
  EntityID,
  Hash,
  IMutateOp,
} from "../../../web/src/shared/types.ts";
import type { ValStat } from "../../../web/src/shared/valstat.ts";
import { SyncClient } from "../../../web/src/client.ts";
import { installPair } from "./pair.ts";
import { entStateManager } from "../../../web/src/entdb/manager.ts";
import { nullStateManager } from "../../../web/src/state.ts";
import { APLD_PENDING, type IStorableMessage } from "../../../web/src/types.ts";
import { noble as crypto } from "../../../web/src/shared/crypto/noble.ts";
import {
  type CliRing,
  decodeRing,
  encodeRing,
} from "../../../tools/keys/cli-prf.ts";
import { readHash } from "./brand.ts";
import { openDisk } from "./open.ts";
import { isRec, run } from "./sql.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dip-disk-"));
}

function stat<T>(pair: ValStat<T>, what: string): T | undefined {
  const [val, st] = pair;
  if (st !== Status.Success) throw new Error(`${what}: ${Status[st]}`);
  return val;
}

function must<T>(pair: ValStat<T>, what: string): NonNullable<T> {
  const val = stat(pair, what);
  if (val === undefined || val === null) throw new Error(what);
  return val;
}

function eid(n: number, ms = 1_700_000_000_000): EntityID {
  const id = new Uint8Array(8);
  id[7] = n;
  return must(makeEID({ id, ts: new Date(ms) }), "eid");
}

function hash(n: number): Hash {
  const bytes = new Uint8Array(32);
  bytes[0] = n;
  const branded = readHash(bytes);
  if (branded === undefined) throw new Error("hash");
  return branded;
}

function master(fill: number): { enclave: Enclave; seed: Uint8Array } {
  const seed = new Uint8Array(32).fill(fill);
  const needle = seed.slice();
  const [enclave, st] = Enclave.fromBytes(seed);
  seed.fill(0);
  if (st !== Status.Success || enclave === undefined) {
    throw new Error("enclave");
  }
  return { enclave, seed: needle };
}

function treeHas(dir: string, needle: Uint8Array): boolean {
  const raw = Buffer.from(needle);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (treeHas(path, needle)) return true;
      continue;
    }
    if (readFileSync(path).includes(raw)) return true;
  }
  return false;
}

function msg(key: Hash, body: Uint8Array, id = eid(1)): IStorableMessage {
  return {
    key,
    data: { eid: id, apld: APLD_PENDING, body, typ: "status" },
  };
}

test("idle tables refuse writes until bind", async () => {
  const dir = tempDir();
  try {
    const disk = openDisk(dir);
    const store = disk.store;
    const host = { label: "host", handle: new URL("http://127.0.0.1:9") };
    expect(await store.hosts.add(host)).toBe(false);
    expect(await store.hosts.list()).toEqual([]);
    expect(
      await store.hosts.set("host", {
        clockOffset: 1,
        subscription: {
          term: 0,
          elapsed: 0,
          stat: { quota: 0 },
          dyn: { quota: 0 },
        },
      }),
    ).toBe(Status.NotFound);
    expect(await store.realms.put("r", 1)).toBe(Status.NotFound);
    expect(await store.realms.list()).toEqual([]);
    const added = await store.messages.add([msg(hash(1), new Uint8Array([1]))]);
    expect(added).toEqual([Status.DatabaseError]);
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists hosts, realms, queues, and messages across reopen", async () => {
  const dir = tempDir();
  try {
    const { enclave, seed } = master(0xa5);
    const disk = openDisk(dir, { maxInlineBytes: 4 });
    const st = await disk.store.account.save(enclave);
    expect(st[1]).toBe(Status.Success);
    expect(await disk.store.bind("")).toBe(Status.Success);
    const url = new URL("http://127.0.0.1:9/diplomatic");
    expect(await disk.store.hosts.add({ label: "host", handle: url, idx: 1 }))
      .toBe(false);
    await disk.store.hosts.recordSeqs("host", { lastSeq: 4 });
    expect(
      await disk.store.hosts.set("host", {
        clockOffset: 12,
        subscription: {
          term: 9,
          elapsed: 3,
          stat: { quota: 8 },
          dyn: { quota: 7, usage: 2 },
        },
      }),
    ).toBe(Status.Success);
    expect(await disk.store.hosts.add({ label: "host", handle: url, idx: 1 }))
      .toBe(true);
    expect((await disk.store.hosts.get("host"))?.lastSeq).toBe(4);
    expect(await disk.store.realms.put("", 0)).toBe(Status.Success);
    expect(await disk.store.realms.put("", 2)).toBe(Status.Success);
    expect(await disk.store.realms.put("", 1)).toBe(Status.InvalidParam);
    const key = hash(3);
    const big = new Uint8Array(8).fill(7);
    expect(await disk.store.messages.add([msg(key, big)])).toEqual([
      Status.Success,
    ]);
    const spill = join(dir, "blobs", Buffer.from(key).toString("hex"));
    expect(existsSync(spill)).toBe(true);
    await disk.store.uploads.enq("host", [key]);
    await disk.store.downloads.enq([{
      host: "host",
      seq: 4,
      kdm: new Uint8Array([1, 2, 3, 4]),
      head: { eid: eid(1), off: 0, ctr: 1, len: 8, typ: "status" },
    }]);
    disk.close();

    expect(treeHas(dir, seed)).toBe(false);
    const again = openDisk(dir, { maxInlineBytes: 4 });
    expect(await again.store.bind("")).toBe(Status.Success);
    const host = await again.store.hosts.get("host");
    expect(host?.handle.href).toBe(url.href);
    expect(host?.idx).toBe(1);
    expect(host?.lastSeq).toBe(4);
    expect(host?.clockOffset).toBe(12);
    expect(host?.subscription?.dyn.usage).toBe(2);
    const realm = await again.store.realms.get("");
    expect(realm?.index).toBe(2);
    expect(realm?.prior).toEqual([0]);
    const got = await again.store.messages.get(key);
    expect(got?.body).toEqual(big);
    expect(await again.store.uploads.list("host")).toEqual([key]);
    const queued = [...await again.store.downloads.list()];
    expect(queued.length).toBe(1);
    expect(queued[0]?.seq).toBe(4);
    const small = new Uint8Array([1, 2]);
    expect(await again.store.messages.add([msg(key, small, eid(2))])).toEqual([
      Status.Success,
    ]);
    expect(existsSync(spill)).toBe(false);
    expect((await again.store.messages.get(key))?.body).toEqual(small);
    await again.store.wipe();
    expect(await again.store.hosts.get("host")).toBe(undefined);
    expect((await again.store.realms.get(""))?.index).toBe(2);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps a host cursor until the handle changes", async () => {
  const dir = tempDir();
  try {
    const { enclave } = master(2);
    const disk = openDisk(dir);
    expect((await disk.store.account.save(enclave))[1]).toBe(Status.Success);
    expect(await disk.store.bind("")).toBe(Status.Success);
    const first = new URL("http://127.0.0.1:9/");
    const second = new URL("http://127.0.0.1:8/");
    await disk.store.hosts.add({ label: "host", handle: first });
    await disk.store.hosts.recordSeqs("host", { setLastSeq: 6 });
    expect((await disk.store.hosts.get("host"))?.lastSeq).toBe(6);
    expect(await disk.store.hosts.hasSeqs("host")).toBe(true);
    await disk.store.hosts.touch("host", 4);
    expect((await disk.store.hosts.get("host"))?.lastSeq).toBe(6);
    await disk.store.hosts.add({ label: "host", handle: second });
    expect((await disk.store.hosts.get("host"))?.lastSeq).toBe(0);
    expect(await disk.store.hosts.hasSeqs("host")).toBe(false);
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a different master and a corrupt key tag", async () => {
  const dir = tempDir();
  try {
    const first = master(3);
    const disk = openDisk(dir);
    expect((await disk.store.account.save(first.enclave))[1]).toBe(
      Status.Success,
    );
    const other = master(4);
    expect((await disk.store.account.save(other.enclave))[1]).toBe(
      Status.HashMismatch,
    );
    const meta = new Database(join(dir, "meta.sqlite"));
    const before: unknown = meta.prepare(
      "SELECT nonce, fingerprint FROM accounts",
    ).get();
    const nonceBefore = field(before, "nonce");
    run(meta, "UPDATE accounts SET fingerprint = ?", new Uint8Array([1]));
    meta.close();
    expect((await disk.store.account.save(first.enclave))[1]).toBe(
      Status.DatabaseError,
    );
    const meta2 = new Database(join(dir, "meta.sqlite"), { readonly: true });
    const after: unknown = meta2.prepare(
      "SELECT nonce, fingerprint FROM accounts",
    ).get();
    meta2.close();
    expect(field(after, "nonce")).toEqual(nonceBefore);
    expect(field(after, "fingerprint")).toEqual(new Uint8Array([1]));
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save keeps a keyring written before the key tag", async () => {
  const dir = tempDir();
  try {
    const { enclave } = master(5);
    const disk = openDisk(dir);
    expect((await disk.openEnts(""))[1]).toBe(Status.Success);
    const meta = new Database(join(dir, "meta.sqlite"));
    const ring = new Uint8Array([9, 9, 9]);
    run(meta, "UPDATE accounts SET keyring = ?", ring);
    meta.close();
    expect((await disk.store.account.save(enclave))[1]).toBe(Status.Success);
    const meta2 = new Database(join(dir, "meta.sqlite"), { readonly: true });
    const got: unknown = meta2.prepare(
      "SELECT nonce, fingerprint, keyring FROM accounts",
    ).get();
    meta2.close();
    expect(field(got, "keyring")).toEqual(ring);
    expect(field(got, "nonce").byteLength).toBe(32);
    expect(field(got, "fingerprint").byteLength).toBe(32);
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applies ents and queries them", async () => {
  const dir = tempDir();
  try {
    const disk = openDisk(dir);
    const edb = must(await disk.openEnts(""), "ents");
    const id = eid(8);
    const body = new TextEncoder().encode("hello");
    const op: IMutateOp<Uint8Array> = {
      eid: id,
      off: 5,
      ctr: 1,
      type: "note",
      body,
      tags: ["alpha", "beta"],
      pid: eid(7),
    };
    const applied = await edb.apply([op]);
    expect(applied.stats).toEqual([Status.Success]);
    const got = must(await edb.getEnt<Uint8Array>(id), "get");
    expect(got.body).toEqual(body);
    expect(got.type).toBe("note");
    const older = await edb.apply([{ ...op, off: 1, ctr: 2 }]);
    expect(older.stats).toEqual([Status.NoChange]);
    const bad: IMutateOp = {
      eid: id,
      off: 9,
      ctr: 3,
      type: "note",
      body: "nope",
    };
    const mixed = await edb.apply([
      { ...op, off: 8, ctr: 2, body: new TextEncoder().encode("next") },
      bad,
    ]);
    expect(mixed.stats[0]).toBe(Status.Success);
    expect(mixed.stats[1]).toBe(Status.InvalidParam);
    expect(must(await edb.getEnt<Uint8Array>(id), "kept").body).toEqual(
      new TextEncoder().encode("next"),
    );
    const tagged = must(
      await edb.getEntities<Uint8Array>({ type: "note", tag: "alp" }),
      "prefix",
    );
    expect(tagged.length).toBe(0);
    const prefix = must(
      await edb.getEntities<Uint8Array>({
        type: "note",
        tag: { prefix: "alp" },
      }),
      "prefix",
    );
    expect(prefix.length).toBe(1);
    const kids = must(
      await edb.getEntities<Uint8Array>({ type: "note", pid: eid(7) }),
      "pid",
    );
    expect(kids.length).toBe(1);
    expect((await edb.checksum(crypto))[1]).toBe(Status.Success);
    const deleted = await edb.apply([{ eid: id, off: 20, ctr: 4 }]);
    expect(deleted.stats).toEqual([Status.Success]);
    expect(stat(await edb.getEnt<Uint8Array>(id), "gone")).toBe(undefined);
    const tomb = must(await edb.getRow(id), "tomb");
    expect("type" in tomb).toBe(false);
    expect(
      must(await edb.getEntities<Uint8Array>({ type: "note" }), "type").length,
    ).toBe(0);
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wipe removes data, ents, and spilled bodies", async () => {
  const dir = tempDir();
  try {
    const { enclave } = master(6);
    const disk = openDisk(dir, { maxInlineBytes: 4 });
    const edb = must(await disk.openEnts(""), "ents");
    await edb.apply([{
      eid: eid(1),
      off: 1,
      ctr: 1,
      type: "status",
      body: new Uint8Array([1]),
    }]);
    expect((await disk.store.account.save(enclave))[1]).toBe(Status.Success);
    expect(await disk.store.bind("")).toBe(Status.Success);
    const key = hash(9);
    await disk.store.messages.add([msg(key, new Uint8Array(8).fill(3))]);
    const names = readdirSync(dir);
    expect(names.some((name) => name.startsWith("data-"))).toBe(true);
    expect(names.some((name) => name.startsWith("ents-"))).toBe(true);
    await disk.store.account.wipe();
    const left = readdirSync(dir);
    expect(left.some((name) => name.startsWith("data-"))).toBe(false);
    expect(left.some((name) => name.startsWith("ents-"))).toBe(false);
    expect(left.includes("blobs")).toBe(true);
    expect(readdirSync(join(dir, "blobs"))).toEqual([]);
    const meta = new Database(join(dir, "meta.sqlite"), { readonly: true });
    const n = meta.prepare("SELECT COUNT(*) AS n FROM accounts").get();
    meta.close();
    expect(n).toEqual({ n: 0 });
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeKeyring leaves the key tag in place", async () => {
  const dir = tempDir();
  try {
    const { enclave } = master(9);
    const disk = openDisk(dir);
    expect((await disk.store.account.save(enclave))[1]).toBe(Status.Success);
    const src: CliRing = {
      v: 2,
      rpId: "diplomatic",
      salt: new Uint8Array(32).fill(7),
      entries: [{
        type: "prf",
        credId: new Uint8Array([1, 2]),
        sealedMaster: new Uint8Array(72).fill(3),
        resident: true,
      }],
    };
    const body = encodeRing(src);
    expect(await disk.store.account.writeKeyring("", body)).toBe(
      Status.Success,
    );
    body.fill(0);
    const got = await disk.store.account.readKeyring("");
    if (got === undefined) throw new Error("keyring");
    const back = decodeRing(got);
    if (back === undefined) throw new Error("decode");
    expect(back.salt).toEqual(new Uint8Array(32).fill(7));
    expect(back.entries[0]?.sealedMaster).toEqual(new Uint8Array(72).fill(3));
    expect((await disk.store.account.save(enclave))[1]).toBe(Status.Success);
    const kept = await disk.store.account.readKeyring("");
    if (kept === undefined) throw new Error("kept");
    expect(decodeRing(kept)?.entries[0]?.resident).toBe(true);
    expect(await disk.store.account.writeKeyring("missing", got)).toBe(
      Status.NotFound,
    );
    disk.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installPair stores the key tag and hosts, not the seed", async () => {
  const dir = tempDir();
  try {
    const { enclave, seed } = master(8);
    const disk = openDisk(dir);
    const client = new SyncClient(
      new Clock(),
      nullStateManager,
      disk.store,
      hostHTTPTransport,
      crypto,
    );
    const [req, rst] = await Enclave.pairRequest();
    expect(rst).toBe(Status.Success);
    if (req === undefined) throw new Error("req");
    const [pub, qst] = req.dhkeReq();
    expect(qst).toBe(Status.Success);
    if (pub === undefined) throw new Error("pub");
    const [resp, ast] = await enclave.pairAccept(
      pub,
      [{ handle: "http://127.0.0.1:9", label: "host", idx: 0 }],
      { userControlsBothSidesOfPair: true },
    );
    expect(ast).toBe(Status.Success);
    if (resp === undefined) throw new Error("resp");
    const [opened, ost] = await req.finish(resp);
    expect(ost).toBe(Status.Success);
    if (opened === undefined) throw new Error("opened");
    expect(await installPair(client, opened, { persist: false })).toBe(
      Status.Success,
    );
    const host = await disk.store.hosts.get("host");
    expect(host?.handle.href).toBe(new URL("http://127.0.0.1:9").href);
    disk.close();
    expect(treeHas(dir, seed)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync client persists a status ent without a live host", async () => {
  const dir = tempDir();
  try {
    const { enclave } = master(7);
    const disk = openDisk(dir);
    const ents = must(await disk.openEnts(""), "ents");
    const client = new SyncClient(
      new Clock(),
      entStateManager(ents),
      disk.store,
      hostHTTPTransport,
      crypto,
    );
    expect(await client.setSeed(enclave)).toBe(Status.Success);
    await client.link({
      handle: new URL("http://127.0.0.1:9"),
      label: "host",
    }, false);
    const body = new TextEncoder().encode("hello");
    const [head, st] = await client.insert({ type: "status", body });
    expect(st).toBe(Status.Success);
    expect(head).toBeDefined();
    const found = must(
      await ents.getEntities<Uint8Array>({ type: "status" }),
      "status",
    );
    expect(found.length).toBe(1);
    expect(found[0]?.body).toEqual(body);
    await Bun.sleep(150);
    disk.close();

    const again = openDisk(dir);
    expect(await again.store.bind("")).toBe(Status.Success);
    const rows = await again.store.messages.list();
    expect(rows.length).toBe(1);
    expect(rows[0]?.head.typ).toBe("status");
    const ents2 = must(await again.openEnts(""), "ents2");
    const text = must(
      await ents2.getEntities<Uint8Array>({ type: "status" }),
      "again",
    );
    expect(text[0]?.body).toEqual(body);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function field(raw: unknown, key: string): Uint8Array {
  if (!isRec(raw)) throw new Error(key);
  const v = raw[key];
  if (!(v instanceof Uint8Array)) throw new Error(key);
  return new Uint8Array(v);
}
