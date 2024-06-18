import { API } from "../src/api.ts";
import type { CipherOp, IOp, ISyncRequest } from "../src/types.ts";
import {
  deriveAuthKeyPair,
  generateSeed,
  IKeyPair,
  sign,
} from "../src/auth.ts";
import { deriveEncryptionKey, encrypt, serialize } from "../src/crypto.ts";
import { encode } from "https://deno.land/x/msgpack@v1.4/mod.ts";
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

type HostID = string;
interface IHost {
  url: string;
  id: HostID;
}

interface IClient {
  seed: Uint8Array;
  encKey: Uint8Array; // crypto_secretstream_xchacha20poly1305_KEYBYTES
  hosts: IHost[];
  keys: Map<HostID, IKeyPair>;
  pendingOps: IOp<"test">[];
}

// Set up client.
const seed = generateSeed();
const client: IClient = {
  // seed: new Uint8Array([0x5E, 0xED]),
  seed,
  encKey: deriveEncryptionKey(seed),
  hosts: [],
  keys: new Map(),
  pendingOps: [],
};

Deno.test("API", async (t) => {
  // Set up server.
  const url = "localhost";
  const api = new API("id", new Date());

  // Register.
  await t.step("registration", () => {
    const hostID = api.getID();
    assertEquals(hostID, "id");

    // Derive keyPair to use with host.
    const keyPair = deriveAuthKeyPair(hostID, seed);
    client.keys.set(hostID, keyPair);
    // const keyPair: IKeyPair = {
    //   privateKey: new Uint8Array([0xEE]),
    //   publicKey: new Uint8Array([0xDF]),
    // };
    client.keys.set(hostID, keyPair);

    api.postUsers(keyPair.publicKey);
    assertEquals(api.users.has(keyPair.publicKey), true);

    client.hosts.push({
      url,
      id: hostID,
    });
  });

  // Generate deltas.
  const op: IOp<"test"> = {
    ts: new Date().toISOString(),
    type: "test",
    verb: 1,
    ver: 0,
    body: {
      x: 22,
    },
  };
  client.pendingOps.push(op);

  // Sync.
  await t.step("sync", () => {
    const encryptedOps: CipherOp[] = [];
    for (const op of client.pendingOps) {
      const ser = serialize(op);
      const enc = encrypt(ser, client.encKey);
      encryptedOps.push(enc);
    }
    // encryptedOps.push(new Uint8Array([0x0D]));

    const keyPair = client.keys.get("id");
    assertNotEquals(keyPair, undefined);
    if (!keyPair) {
      return;
    }

    const req: ISyncRequest = {
      begin: new Date().toUTCString(),
      ops: encryptedOps,
    };
    const reqPack = encode(req);
    const sig = sign(reqPack, keyPair);

    const pubKey = keyPair.publicKey;
    const resp = api.postSync(reqPack, pubKey, sig);
    const storedOp = Array.from(api.ops.get(pubKey)?.values() ?? [])?.[0];
    assertEquals(storedOp, encryptedOps[0]);
    assertEquals(resp.ops.length, 0);
  });

  // TODO: sync another client.
});
