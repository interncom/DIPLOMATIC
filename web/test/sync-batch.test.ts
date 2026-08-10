import { describe, expect, test } from "vitest";
import { openPulled, pullBodies, pushBatch } from "../src/sync";
import { MemoryStore } from "../src/stores/memory/store";
import libsodiumCrypto from "../src/crypto";
import { Enclave } from "../src/shared/crypto/enclave";
import { Status } from "../src/shared/consts";
import type { Hash, HostHandle, IBag } from "../src/shared/types";
import type { MasterSeed } from "../src/shared/seed";
import { ok, err } from "../src/shared/valstat";
import { APLD_PENDING } from "../src/types";
import type { IDownloadMessage } from "../src/types";
import { sealBag } from "../src/shared/bag";
import type { IMessage } from "../src/shared/types";

const testSeed = new Uint8Array(32).fill(0x42) as MasterSeed;

function hash(n: number): Hash {
  return new Uint8Array(32).fill(n) as Hash;
}

function fakeBag(n = 1): IBag {
  return {
    sig: new Uint8Array(64).fill(n),
    kdm: new Uint8Array(8).fill(n),
    headCph: new Uint8Array(16).fill(n),
    bodyCph: new Uint8Array(8).fill(n) };
}

describe("pushBatch", () => {
  test("dequeues successful uploads and advances lastSeq from store", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    await store.hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1 });
    await store.hosts.touch("h", 10);

    const h1 = hash(1);
    const h2 = hash(2);
    await store.uploads.enq("h", [h1, h2]);

    const conn = {
      push: async () =>
        ok([
          { idx: 0, status: Status.Success, seq: 11 },
          { idx: 1, status: Status.Success, seq: 12 },
        ]) };

    const st = await pushBatch(conn, store, "h", [fakeBag(1), fakeBag(2)], [
      h1,
      h2,
    ]);

    expect(st).toBe(Status.Success);
    expect(await store.uploads.list("h")).toEqual([]);
    expect((await store.hosts.get("h"))?.lastSeq).toBe(12);
  });

  test("leaves failed items on the upload queue", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    await store.hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1 });

    const h1 = hash(1);
    const h2 = hash(2);
    await store.uploads.enq("h", [h1, h2]);

    const conn = {
      push: async () =>
        ok([
          { idx: 0, status: Status.Success, seq: 1 },
          { idx: 1, status: Status.InvalidSignature },
        ]) };

    const st = await pushBatch(conn, store, "h", [fakeBag(), fakeBag()], [
      h1,
      h2,
    ]);

    expect(st).toBe(Status.Success);
    const left = await store.uploads.list("h");
    expect(left).toHaveLength(1);
    expect(left[0]).toEqual(h2);
    expect((await store.hosts.get("h"))?.lastSeq).toBe(1);
  });

  test("does not jump lastSeq over a gap", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    await store.hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1 });
    await store.hosts.touch("h", 5);

    const h1 = hash(1);
    await store.uploads.enq("h", [h1]);

    const conn = {
      push: async () => ok([{ idx: 0, status: Status.Success, seq: 9 }]) };

    await pushBatch(conn, store, "h", [fakeBag()], [h1]);
    expect((await store.hosts.get("h"))?.lastSeq).toBe(5);
  });

  test("propagates request-level push failure", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    await store.hosts.add({
      label: "h",
      handle: new URL("http://localhost"),
      idx: 1 });
    const h1 = hash(1);
    await store.uploads.enq("h", [h1]);

    const conn = {
      push: async () => err(Status.CommunicationError) };

    const st = await pushBatch(conn, store, "h", [fakeBag()], [h1]);
    expect(st).toBe(Status.CommunicationError);
    expect(await store.uploads.list("h")).toHaveLength(1);
  });
});

describe("pullBodies + openPulled", () => {
  test("pull then open archives msg and deqs download", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    const enclave = new Enclave(testSeed, libsodiumCrypto);
    const hostIdnt = await enclave.deriveIdentity("test", 1);

    const body = new Uint8Array([1, 2, 3, 4]);
    const message: IMessage = {
      eid: new Uint8Array(16).fill(1),
      off: 0,
      ctr: 0,
      len: body.length,
      bod: body };
    const [bag, bagStat] = await sealBag(
      message,
      hostIdnt,
      libsodiumCrypto,
      enclave,
    );
    expect(bagStat).toBe(Status.Success);
    if (!bag) return;

    const item: IDownloadMessage = {
      seq: 1,
      host: "h",
      kdm: bag.kdm,
      head: {
        eid: message.eid,
        off: 0,
        ctr: 0,
        len: body.length,
        hsh: await libsodiumCrypto.blake3(body) } };
    await store.downloads.enq([item]);

    const conn = {
      pull: async () => ok([{ seq: 1, bodyCph: bag.bodyCph }]) };

    const [pulled, pullStat] = await pullBodies(conn, [item]);
    expect(pullStat).toBe(Status.Success);
    expect(pulled).toHaveLength(1);

    const [opened, openStat] = await openPulled(
      store,
      enclave,
      libsodiumCrypto,
      pulled ?? [],
    );
    expect(openStat).toBe(Status.Success);
    expect(opened?.parts).toHaveLength(1);
    expect(opened?.parts[0].body).toEqual(body);
    expect(await store.downloads.count()).toBe(0);
    const msgs = Array.from(await store.messages.list());
    expect(msgs).toHaveLength(1);
    expect(msgs[0].apld).toBe(APLD_PENDING);
    expect(msgs[0].body).toEqual(body);
  });

  test("propagates pull failure and leaves queue intact", async () => {
    const store = new MemoryStore<HostHandle>(libsodiumCrypto);
    const item: IDownloadMessage = {
      seq: 3,
      host: "h",
      kdm: new Uint8Array(8),
      head: {
        eid: new Uint8Array(16).fill(3),
        off: 0,
        ctr: 0,
        len: 1 } };
    await store.downloads.enq([item]);

    const conn = {
      pull: async () => err(Status.HostError) };

    const [, st] = await pullBodies(conn, [item]);
    expect(st).toBe(Status.HostError);
    expect(await store.downloads.count()).toBe(1);
  });
});

