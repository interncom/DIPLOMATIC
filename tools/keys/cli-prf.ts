// CLI PRF binding: fido2-tools hmac-secret, seal file, keystroke mix.
// CLI salt is raw hmac-secret (not the browser's SHA-256 "WebAuthn PRF" map).

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { btoh, bytesEqual, htob } from "../../shared/binary.ts";
import { Status } from "../../shared/consts.ts";
import { Enclave } from "../../shared/crypto/enclave.ts";
import { NobleCrypto } from "../../shared/crypto/noble.ts";
import { asSealedMasterKey } from "../../shared/seed.ts";

export const CLI_RP_ID = "diplomatic";
export const CLI_USER = "diplomatic-cli";
const SALT_DOM = new TextEncoder().encode("diplomatic.cli.prf.v1");
const MIN_KEYS = 16;
const KEYRING_MAX = 8;
const noble = new NobleCrypto();

export type CliEntry = {
  type: "prf";
  credId: Uint8Array;
  sealedMaster: Uint8Array;
  resident: boolean;
};

export type CliRing = {
  v: 2;
  rpId: string;
  salt: Uint8Array;
  entries: CliEntry[];
};

/** Abort with a message on stderr. */
export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Reject path separators and empty/dot labels. */
export function parseLabel(s: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") {
    die(`bad label ${s}`);
  }
  return s;
}

/** LABEL plus optional `--non-resident` from argv (after the script name). */
export function parseKeyArgs(argv: string[]): {
  label: string;
  resident: boolean;
} {
  const resident = !argv.includes("--non-resident");
  const rest = argv.filter((a) => a !== "--non-resident");
  const a0 = rest[0];
  if (a0 === undefined || a0 === "-h" || a0 === "--help") {
    return { label: "", resident };
  }
  return { label: parseLabel(a0), resident };
}

/** `~/.diplomatic/<LABEL>` */
export function ringPath(label: string): string {
  const home = homedir();
  if (home.length === 0) die("HOME unset");
  return join(home, ".diplomatic", parseLabel(label));
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

function parseEntry(v: unknown): CliEntry {
  if (!isRec(v) || v.type !== "prf") die("bad keyring entry");
  return {
    type: "prf",
    credId: hexField(v, "credId"),
    sealedMaster: hexField(v, "sealedMaster", 72),
    resident: v.resident === true,
  };
}

/** Load a CLI keyring. Missing file → undefined. */
export function loadRing(path: string): CliRing | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    die(`failed to read ${path}: ${e}`);
  }
  if (!isRec(raw) || raw.v !== 2) die(`bad keyring ${path} (want v: 2)`);
  if (typeof raw.rpId !== "string" || raw.rpId.length === 0) {
    die("bad keyring rpId");
  }
  if (!Array.isArray(raw.entries)) die("bad keyring entries");
  return {
    v: 2,
    rpId: raw.rpId,
    salt: hexField(raw, "salt", 32),
    entries: raw.entries.map(parseEntry),
  };
}

/** Write a CLI keyring (mode 0600). */
export function writeRing(path: string, ring: CliRing): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    v: 2,
    rpId: ring.rpId,
    salt: btoh(ring.salt),
    entries: ring.entries.map((e) => ({
      type: "prf",
      credId: btoh(e.credId),
      sealedMaster: btoh(e.sealedMaster),
      resident: e.resident,
    })),
  }) + "\n";
  writeFileSync(path, body, { mode: 0o600 });
}

/** Insert or replace an entry by credId. */
export function upsertEntry(ring: CliRing, next: CliEntry): void {
  const i = ring.entries.findIndex((e) => bytesEqual(e.credId, next.credId));
  if (i >= 0) {
    ring.entries[i] = next;
    return;
  }
  if (ring.entries.length >= KEYRING_MAX) {
    die(`keyring full (${KEYRING_MAX})`);
  }
  ring.entries.push(next);
}

function b64enc(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64pad(s: string): Uint8Array {
  const t = s.trim();
  const pad = t.length % 4 === 0 ? t : t + "=".repeat(4 - (t.length % 4));
  return Uint8Array.from(Buffer.from(pad, "base64"));
}

function spawnFido(
  argv: string[],
  input: string,
): { status: number; out: string } {
  const r = spawnSync(argv[0] ?? "fido2-token", argv.slice(1), {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (r.error) die(`${argv[0]}: ${r.error.message} (install fido2-tools)`);
  return { status: r.status ?? 1, out: r.stdout ?? "" };
}

function runFido(argv: string[], input: string): string {
  const r = spawnFido(argv, input);
  if (r.status !== 0) die(`${argv[0]} failed (${r.status})`);
  return r.out;
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

/** Create a hmac-secret cred; returns cred id. `-r` when resident. */
export function makeHmacCred(
  dev: string,
  rpId: string,
  opts?: { resident?: boolean; userName?: string },
): Uint8Array {
  const cdh = new Uint8Array(32);
  const uid = new Uint8Array(16);
  crypto.getRandomValues(cdh);
  crypto.getRandomValues(uid);
  const user = opts?.userName ?? CLI_USER;
  const input = [b64enc(cdh), rpId, user, b64enc(uid)].join("\n") + "\n";
  const argv = ["fido2-cred", "-M", "-h", "-t", "uv=true", "-t", "pin=true"];
  if (opts?.resident !== false) argv.push("-r");
  argv.push(dev);
  console.error(
    opts?.resident === false
      ? "Touch the key / enter PIN to create a PRF credential..."
      : "Touch the key / enter PIN to create a resident PRF credential...",
  );
  const out = runFido(argv, input);
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const idLine = lines[4];
  if (idLine === undefined) die("fido2-cred: no credential id");
  const id = b64pad(idLine);
  if (id.byteLength === 0) die("fido2-cred: empty credential id");
  cdh.fill(0);
  uid.fill(0);
  return id;
}

function parseHmacOut(out: string): Uint8Array | undefined {
  const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = 4; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const b = b64pad(line);
    if (b.byteLength === 32) return b;
  }
  return undefined;
}

/** Eval hmac-secret (UV); returns 32-byte IKM or undefined if assert fails. */
export function tryEvalHmac(
  dev: string,
  rpId: string,
  credId: Uint8Array,
  salt: Uint8Array,
): Uint8Array | undefined {
  if (salt.byteLength !== 32) die("hmac-secret salt must be 32 bytes");
  const cdh = new Uint8Array(32);
  crypto.getRandomValues(cdh);
  const input = [b64enc(cdh), rpId, b64enc(credId), b64enc(salt)].join("\n") +
    "\n";
  console.error("Touch the key / enter PIN to evaluate PRF...");
  const r = spawnFido(
    ["fido2-assert", "-G", "-h", "-t", "uv=true", "-t", "pin=true", dev],
    input,
  );
  cdh.fill(0);
  if (r.status !== 0) return undefined;
  return parseHmacOut(r.out);
}

/** Eval hmac-secret (UV); returns 32-byte IKM. */
export function evalHmac(
  dev: string,
  rpId: string,
  credId: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  const ikm = tryEvalHmac(dev, rpId, credId, salt);
  if (ikm === undefined) die("fido2-assert: no hmac-secret in output");
  return ikm;
}

/** Collect keystroke timings from a TTY (musec for Enclave.fromRandom). */
export async function collectMusec(): Promise<Uint8Array> {
  console.error(`Type random keys, then Enter (${MIN_KEYS}+ keys).`);
  return await readKeys(MIN_KEYS);
}

/** Collect keystroke timings from a TTY until Enter. */
async function readKeys(min: number): Promise<Uint8Array> {
  const stdin = process.stdin;
  if (!stdin.isTTY) die("gen needs a TTY for keystroke entropy");
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

/** UV-eval each keyring cred until one unseals. */
export async function unlockRing(ring: CliRing, dev: string): Promise<Enclave> {
  if (ring.entries.length === 0) die("empty keyring");
  for (const e of ring.entries) {
    const tail = btoh(e.credId);
    const short = tail.length <= 8 ? tail : tail.slice(tail.length - 8);
    console.error(`Trying cred …${short}`);
    const [sm, sst] = asSealedMasterKey(e.sealedMaster);
    if (sst !== Status.Success || sm === undefined) continue;
    const ikm = tryEvalHmac(dev, ring.rpId, e.credId, ring.salt);
    if (ikm === undefined) continue;
    const [enc, est] = await Enclave.unsealWithIkm(sm, ikm);
    if (est === Status.Success && enc !== undefined) return enc;
  }
  die("no keyring entry unsealed (wrong YubiKey?)");
}

/** Wait for Enter on a TTY (key swap before binding another token). */
export async function waitEnter(msg: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  console.error(msg);
  await new Promise<void>((resolve) => {
    const onData = (buf: Buffer | string) => {
      const s = typeof buf === "string" ? buf : buf.toString("utf8");
      if (s.includes("\n") || s.includes("\r")) {
        process.stdin.off("data", onData);
        resolve();
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
