// CLI PRF binding: fido2-tools hmac-secret, seal file, keystroke mix.
// CLI salt is raw hmac-secret (not the browser's SHA-256 "WebAuthn PRF" map).

import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { btoh, htob } from "../shared/binary.ts";
import { Status } from "../shared/consts.ts";
import { Enclave } from "../shared/crypto/enclave.ts";
import { NobleCrypto } from "../shared/crypto/noble.ts";
import { asSealedMasterKey } from "../shared/seed.ts";

export const CLI_RP_ID = "diplomatic";
export const CLI_USER = "diplomatic-cli";
const SALT_DOM = new TextEncoder().encode("diplomatic.cli.prf.v1");
const MIN_KEYS = 16;
const noble = new NobleCrypto();

export type CliBind = {
  v: 1;
  type: "prf";
  rpId: string;
  salt: Uint8Array;
  credId: Uint8Array;
  sealedMaster: Uint8Array;
};

/** Abort with a message on stderr. */
export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Default binding path (`~/.diplomatic`). */
export function defaultBindPath(): string {
  const home = homedir();
  if (home.length === 0) die("HOME unset");
  return join(home, ".diplomatic");
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hexField(
  o: Record<string, unknown>,
  k: string,
  n?: number,
): Uint8Array {
  const v = o[k];
  if (typeof v !== "string" || !/^[0-9a-fA-F]+$/.test(v) || v.length % 2 !== 0) {
    die(`bad binding field ${k}`);
  }
  if (n !== undefined && v.length !== n * 2) die(`bad binding field ${k} length`);
  return htob(v);
}

/** Load a CLI PRF binding file. */
export function loadBind(path: string): CliBind {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`failed to read ${path}: ${e}`);
  }
  if (!isRec(raw) || raw.v !== 1 || raw.type !== "prf") {
    die(`bad binding ${path}`);
  }
  if (typeof raw.rpId !== "string" || raw.rpId.length === 0) {
    die("bad binding rpId");
  }
  return {
    v: 1,
    type: "prf",
    rpId: raw.rpId,
    salt: hexField(raw, "salt", 32),
    credId: hexField(raw, "credId"),
    sealedMaster: hexField(raw, "sealedMaster", 72),
  };
}

/** Write a CLI PRF binding (mode 0600). Refuses to overwrite. */
export function saveBind(path: string, b: CliBind): void {
  if (existsSync(path)) die(`refusing to overwrite ${path}`);
  const body = JSON.stringify({
    v: 1,
    type: "prf",
    rpId: b.rpId,
    salt: btoh(b.salt),
    credId: btoh(b.credId),
    sealedMaster: btoh(b.sealedMaster),
  }) + "\n";
  writeFileSync(path, body, { mode: 0o600 });
}

function b64enc(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64pad(s: string): Uint8Array {
  const t = s.trim();
  const pad = t.length % 4 === 0 ? t : t + "=".repeat(4 - (t.length % 4));
  return Uint8Array.from(Buffer.from(pad, "base64"));
}

function runFido(argv: string[], input: string): string {
  const r = spawnSync(argv[0] ?? "fido2-token", argv.slice(1), {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (r.error) die(`${argv[0]}: ${r.error.message} (install fido2-tools)`);
  if (r.status !== 0) die(`${argv[0]} failed (${r.status})`);
  return r.stdout ?? "";
}

/** First hidraw/ioreg path from `fido2-token -L`, or DIP_FIDO_DEV. */
export function fidoDev(): string {
  const env = process.env.DIP_FIDO_DEV;
  if (env !== undefined && env.length > 0) return env;
  const out = runFido(["fido2-token", "-L"], "");
  const line = out.split("\n").find((l) => l.trim().length > 0);
  if (line === undefined) die("no FIDO device (plug in a YubiKey)");
  const cut = line.split(": ")[0];
  if (cut === undefined || cut.length === 0) die("bad fido2-token -L output");
  return cut;
}

/** 32-byte hmac-secret salt for CLI bindings. */
export async function cliSalt(): Promise<Uint8Array> {
  return await noble.blake3(SALT_DOM);
}

/** Create a non-resident hmac-secret cred; returns cred id. */
export function makeHmacCred(dev: string, rpId: string): Uint8Array {
  const cdh = new Uint8Array(32);
  const uid = new Uint8Array(16);
  crypto.getRandomValues(cdh);
  crypto.getRandomValues(uid);
  const input = [b64enc(cdh), rpId, CLI_USER, b64enc(uid)].join("\n") + "\n";
  console.error("Touch the key / enter PIN to create a PRF credential...");
  const out = runFido(
    ["fido2-cred", "-M", "-h", "-t", "uv=true", "-t", "pin=true", dev],
    input,
  );
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const idLine = lines[4];
  if (idLine === undefined) die("fido2-cred: no credential id");
  const id = b64pad(idLine);
  if (id.byteLength === 0) die("fido2-cred: empty credential id");
  cdh.fill(0);
  uid.fill(0);
  return id;
}

/** Eval hmac-secret (UV); returns 32-byte IKM. */
export function evalHmac(
  dev: string,
  rpId: string,
  credId: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  if (salt.byteLength !== 32) die("hmac-secret salt must be 32 bytes");
  const cdh = new Uint8Array(32);
  crypto.getRandomValues(cdh);
  const input = [b64enc(cdh), rpId, b64enc(credId), b64enc(salt)].join("\n") +
    "\n";
  console.error("Touch the key / enter PIN to evaluate PRF...");
  const out = runFido(
    ["fido2-assert", "-G", "-h", "-t", "uv=true", "-t", "pin=true", dev],
    input,
  );
  cdh.fill(0);
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const b = b64pad(line);
    if (b.byteLength === 32) return b;
  }
  die("fido2-assert: no hmac-secret in output");
}

/** Collect keystroke timings from a TTY (musec for Enclave.fromRandom). */
export async function collectMusec(): Promise<Uint8Array> {
  console.error(`Type random keys, then Enter (${MIN_KEYS}+ keys).`);
  return await readKeys(MIN_KEYS);
}

/** Collect keystroke timings from a TTY until Enter. */
async function readKeys(min: number): Promise<Uint8Array> {
  const stdin = process.stdin;
  if (!stdin.isTTY) die("keygen needs a TTY for keystroke entropy");
  stdin.setRawMode(true);
  stdin.resume();
  const chunks: number[] = [];
  let n = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (buf: Buffer | string) => {
        const bytes = typeof buf === "string"
          ? new TextEncoder().encode(buf)
          : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let i = 0; i < bytes.byteLength; i++) {
          const c = bytes[i];
          if (c === undefined) continue;
          if (c === 3) {
            stdin.off("data", onData);
            reject(new Error("aborted"));
            return;
          }
          if (c === 13 || c === 10) {
            if (n < min) {
              process.stderr.write(` (${min - n} more)\n`);
              continue;
            }
            stdin.off("data", onData);
            resolve();
            return;
          }
          if (c === 127 || c === 8) continue;
          const now = BigInt(Math.floor(performance.now() * 1e6));
          chunks.push(Number((now >> 56n) & 0xffn));
          chunks.push(Number((now >> 48n) & 0xffn));
          chunks.push(Number((now >> 40n) & 0xffn));
          chunks.push(Number((now >> 32n) & 0xffn));
          chunks.push(Number((now >> 24n) & 0xffn));
          chunks.push(Number((now >> 16n) & 0xffn));
          chunks.push(Number((now >> 8n) & 0xffn));
          chunks.push(Number(now & 0xffn));
          chunks.push(c);
          n++;
          process.stderr.write(".");
        }
      };
      stdin.on("data", onData);
    });
  } catch {
    die("aborted");
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  process.stderr.write("\n");
  return new Uint8Array(chunks);
}

/** UV-eval the binding's cred and return an Enclave. */
export async function unlockBind(b: CliBind, dev: string): Promise<Enclave> {
  const [sm, sst] = asSealedMasterKey(b.sealedMaster);
  if (sst !== Status.Success || sm === undefined) die("bad sealed master");
  const ikm = evalHmac(dev, b.rpId, b.credId, b.salt);
  const [enc, est] = await Enclave.unsealWithIkm(sm, ikm);
  if (est !== Status.Success || enc === undefined) {
    die(`unseal failed (${est})`);
  }
  return enc;
}
