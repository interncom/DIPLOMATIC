// Seed store: durable PRF keyring in protocol IDB + unlock via PRF ceremony.
// Session handle is always an Enclave. PRF bytes never leave Enclave methods.
// WebAuthn “authenticator” = binding key (IKM for the seal, not authn/authz).

import {
  asChildKey,
  type ChildKey,
  Enclave,
  type PasskeyPrfOpts,
  Purpose,
} from "../shared/crypto/enclave";
import { Status } from "../shared/consts";
import { bytesEqual } from "../shared/binary";
import { asSealedMasterKey, type SealedMasterKey } from "../shared/seed";
import { err, ok, type ValStat } from "../shared/valstat";
import type { ISeedStore, SetSeedOpts } from "../types";
import { DEFAULT_PRF_USER_NAME, type PrfRp } from "../shared/webauthn/prf";
import {
  type AuthenticatorAttachmentName,
  type EnrolledOs,
  enrolledOsFromUA,
} from "../shared/webauthn/common";

/** Max bindings on one device. Keeps allowCredentials small. */
export const KEYRING_MAX = 8;

export type KeyringType = "prf";

/** One PRF binding (one binding key). Future types (shard, …) share this list. */
export type KeyringEntry = {
  type: "prf";
  sealedMaster: SealedMasterKey;
  credId: Uint8Array;
  /** Bind-tag PDK child keyed by credId; check-only, not a display fingerprint. */
  tag: ChildKey<typeof Purpose.BindTag>;
  userId?: Uint8Array;
  nick?: string;
  enrolledAt: number;
  lastUsedAt?: number;
  attachment?: AuthenticatorAttachmentName;
  transports?: string[];
  aaguid?: Uint8Array;
  enrolledOs?: EnrolledOs;
};

/** Local keyring: one PRF salt, a flat list of typed bindings. */
export type Keyring = {
  salt: Uint8Array;
  entries: KeyringEntry[];
};

/** Public row — no sealed bytes. */
export type KeyringRow = {
  type: "prf";
  credId: Uint8Array;
  userId?: Uint8Array;
  nick?: string;
  enrolledAt: number;
  lastUsedAt?: number;
  attachment?: AuthenticatorAttachmentName;
  transports?: string[];
  aaguid?: Uint8Array;
  enrolledOs?: EnrolledOs;
};

/**
 * Persist the keyring for cold start (e.g. protocol IDB).
 * Called with `undefined` when the store is wiped.
 */
export type PersistKeyring = (
  ring: Keyring | undefined,
) => Status | Promise<Status>;

export type PrfSeedStoreOpts = PrfRp & {
  persistKeyring: PersistKeyring;
  keyring?: Keyring;
};

/**
 * Session + durable PRF-bound seed. Session secret is always {@link Enclave}.
 *
 * - {@link save} is memory-only (holds enclave).
 * - {@link bindAndSave} creates a binding and appends/upserts a keyring entry.
 * - {@link unlock} runs PRF UV inside Enclave and returns a new enclave.
 */
export class PrfSeedStore implements ISeedStore {
  #enclave: Enclave | undefined;
  #keyring: Keyring | undefined;
  #rp: PrfRp;
  /** WebAuthn user.name — rpId (hostname) so the binding key is app-specific. */
  #userName: string;
  #persist: PersistKeyring;

  constructor(opts: Omit<PrfSeedStoreOpts, "keyring">) {
    this.#persist = opts.persistKeyring;
    this.#rp = { rpId: opts.rpId, rpName: opts.rpName };
    this.#userName = opts.userName ?? opts.rpId ?? opts.rpName ??
      DEFAULT_PRF_USER_NAME;
  }

  // Copies `opts.keyring` in. Fails instead of starting with an empty ring.
  static open(opts: PrfSeedStoreOpts): ValStat<PrfSeedStore> {
    const store = new PrfSeedStore(opts);
    if (opts.keyring === undefined) return ok(store);
    const [ring, st] = cloneKeyring(opts.keyring);
    if (st !== Status.Success) return err(st);
    store.#keyring = ring;
    return ok(store);
  }

  get keyring(): Keyring | undefined {
    if (this.#keyring === undefined) return undefined;
    const [ring, st] = cloneKeyring(this.#keyring);
    if (st !== Status.Success) return undefined;
    return ring;
  }

  /** Public rows (no sealed master). */
  list(): KeyringRow[] {
    if (this.#keyring === undefined) return [];
    return this.#keyring.entries.map(toRow);
  }

  async save(
    enclave: Enclave,
    opts?: SetSeedOpts,
  ): Promise<ValStat<Enclave>> {
    if (opts?.persist === true) return err(Status.InvalidParam);
    this.#enclave = enclave;
    return ok(this.#enclave);
  }

  /**
   * PRF UV inside Enclave.bind, persist the entry.
   * Always creates a new cred unless `credId` is passed (re-bind that cred).
   * Existing tags are checked inside the enclave (one keyring, one master).
   */
  async bindAndSave(
    enclave: Enclave,
    opts?:
      & Pick<
        PasskeyPrfOpts,
        | "salt"
        | "credId"
        | "createCredIfNeeded"
        | "authenticatorAttachment"
        | "hints"
        | "excludeCredentials"
      >
      & {
        nick?: string;
      },
  ): Promise<ValStat<Enclave>> {
    const ring = this.#keyring;
    const credIn = opts?.credId;
    const known = credIn instanceof Uint8Array
      ? credIn.byteLength > 0
      : credIn !== undefined && credIn.length > 0;
    if (
      !known && ring !== undefined && ring.entries.length >= KEYRING_MAX
    ) {
      return err(Status.VarLimitExceeded);
    }
    const nick = trimNick(opts?.nick);
    const exclude = opts?.excludeCredentials ??
      (known ? undefined : keyringCredIds(ring));
    const salt = opts?.salt ?? ring?.salt;
    const prior = ring === undefined ? undefined : ring.entries.map((e) => ({
      credId: e.credId,
      tag: e.tag,
    }));
    const [bound, bst] = await enclave.bind({
      ...this.#rp,
      salt,
      credId: credIn,
      createCredIfNeeded: opts?.createCredIfNeeded ?? !known,
      excludeCredentials: exclude,
      userName: this.#userName,
      displayName: nick ?? this.#rp.rpName ?? this.#userName,
      authenticatorAttachment: opts?.authenticatorAttachment,
      hints: opts?.hints,
    }, prior);
    if (bst !== Status.Success) return err(bst);

    const now = Date.now();
    const next: KeyringEntry = {
      type: "prf",
      sealedMaster: bound.sealedMaster,
      credId: bound.credId,
      tag: bound.tag,
      userId: bound.userId,
      nick,
      enrolledAt: now,
      lastUsedAt: now,
      attachment: bound.attachment,
      transports: bound.transports,
      aaguid: bound.aaguid,
      enrolledOs: enrolledOsHere(),
    };
    const base: Keyring = ring === undefined
      ? { salt: bound.salt.slice(), entries: [] }
      : ring;
    const [stored, ust] = upsertEntry(base, next);
    if (ust !== Status.Success) return err(ust);
    const pst = await this.#persist(stored);
    if (pst !== Status.Success) return err(pst);
    this.#keyring = stored;
    this.#enclave = enclave;
    return ok(this.#enclave);
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  /** Passkey UV inside Enclave → new session enclave. */
  async unlock(): Promise<ValStat<Enclave>> {
    const ring = this.#keyring;
    if (ring === undefined || ring.entries.length === 0) {
      return err(Status.MissingSeed);
    }
    const [out, ust] = await Enclave.unsealWithPasskey(
      ring.entries.map((e) => ({
        sealedMaster: e.sealedMaster,
        credId: e.credId,
      })),
      { ...this.#rp, salt: ring.salt },
    );
    if (ust !== Status.Success) return err(ust);
    this.#enclave = out.enclave;
    const [next, tst] = touchEntry(ring, out.credId);
    if (tst !== Status.Success) return err(tst);
    if (next !== undefined) {
      const pst = await this.#persist(next);
      if (pst !== Status.Success) return err(pst);
      this.#keyring = next;
    }
    return ok(out.enclave);
  }

  /** Set a display nick (local only; does not update the binding key). */
  async rename(credId: Uint8Array, nick: string): Promise<ValStat<void>> {
    const ring = this.#keyring;
    if (ring === undefined) return err(Status.MissingSeed);
    const i = ring.entries.findIndex((e) => bytesEqual(e.credId, credId));
    if (i < 0) return err(Status.NotFound);
    const [entries, est] = cloneEntries(ring.entries);
    if (est !== Status.Success) return err(est);
    const cur = entries[i];
    if (cur === undefined) return err(Status.NotFound);
    const trimmed = trimNick(nick);
    entries[i] = { ...cur, nick: trimmed };
    const next: Keyring = { salt: ring.salt.slice(), entries };
    const pst = await this.#persist(next);
    if (pst !== Status.Success) return err(pst);
    this.#keyring = next;
    return ok(undefined);
  }

  /**
   * Drop a binding from this browser. Does not delete the binding-key cred.
   * Last entry clears the keyring.
   */
  async remove(credId: Uint8Array): Promise<ValStat<void>> {
    const ring = this.#keyring;
    if (ring === undefined) return err(Status.MissingSeed);
    const entries = ring.entries.filter((e) => !bytesEqual(e.credId, credId));
    if (entries.length === ring.entries.length) return err(Status.NotFound);
    if (entries.length === 0) {
      const pst = await this.#persist(undefined);
      if (pst !== Status.Success) return err(pst);
      this.#keyring = undefined;
      return ok(undefined);
    }
    const [copied, cst] = cloneEntries(entries);
    if (cst !== Status.Success) return err(cst);
    const next: Keyring = { salt: ring.salt.slice(), entries: copied };
    const pst = await this.#persist(next);
    if (pst !== Status.Success) return err(pst);
    this.#keyring = next;
    return ok(undefined);
  }

  async wipe(): Promise<void> {
    this.#enclave = undefined;
    this.#keyring = undefined;
    await this.#persist(undefined);
  }
}

function trimNick(n: string | undefined): string | undefined {
  if (n === undefined) return undefined;
  const t = n.trim();
  return t === "" ? undefined : t;
}

function enrolledOsHere(): EnrolledOs | undefined {
  if (typeof navigator === "undefined") return undefined;
  return enrolledOsFromUA(navigator.userAgent);
}

// Copies one entry. Fails the clone if the sealed master or bind tag does not re-brand.
function cloneEntry(e: KeyringEntry): ValStat<KeyringEntry> {
  const [sealedMaster, sst] = asSealedMasterKey(e.sealedMaster.slice());
  if (sst !== Status.Success) return err(sst);
  const [tag, tst] = asChildKey(e.tag.slice(), Purpose.BindTag);
  if (tst !== Status.Success) return err(tst);
  return ok({
    type: "prf",
    sealedMaster,
    credId: e.credId.slice(),
    tag,
    userId: e.userId === undefined ? undefined : e.userId.slice(),
    nick: e.nick,
    enrolledAt: e.enrolledAt,
    lastUsedAt: e.lastUsedAt,
    attachment: e.attachment,
    transports: e.transports === undefined ? undefined : [...e.transports],
    aaguid: e.aaguid === undefined ? undefined : e.aaguid.slice(),
    enrolledOs: e.enrolledOs,
  });
}

function cloneEntries(entries: KeyringEntry[]): ValStat<KeyringEntry[]> {
  const out: KeyringEntry[] = [];
  for (const e of entries) {
    const [c, st] = cloneEntry(e);
    if (st !== Status.Success) return err(st);
    out.push(c);
  }
  return ok(out);
}

export function cloneKeyring(r: Keyring): ValStat<Keyring> {
  const [entries, st] = cloneEntries(r.entries);
  if (st !== Status.Success) return err(st);
  return ok({ salt: r.salt.slice(), entries });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

function decodeEntry(raw: unknown): KeyringEntry | undefined {
  if (!isRecord(raw) || raw.type !== "prf") return undefined;
  if (
    !(raw.sealedMaster instanceof Uint8Array) ||
    !(raw.credId instanceof Uint8Array) ||
    !(raw.tag instanceof Uint8Array) ||
    typeof raw.enrolledAt !== "number" ||
    !Number.isFinite(raw.enrolledAt)
  ) {
    return undefined;
  }
  const [sealedMaster, st] = asSealedMasterKey(raw.sealedMaster);
  if (st !== Status.Success) return undefined;
  const [tag, tst] = asChildKey(raw.tag.slice(), Purpose.BindTag);
  if (tst !== Status.Success) return undefined;
  const attachment = raw.attachment === "platform" ||
      raw.attachment === "cross-platform"
    ? raw.attachment
    : undefined;
  const os = raw.enrolledOs;
  const enrolledOs =
    os === "ios" || os === "macos" || os === "android" || os === "windows" ||
      os === "linux" || os === "other"
      ? os
      : undefined;
  const transports = Array.isArray(raw.transports)
    ? raw.transports.filter((t) => typeof t === "string")
    : undefined;
  return {
    type: "prf",
    sealedMaster,
    credId: raw.credId.slice(),
    tag,
    userId: raw.userId instanceof Uint8Array ? raw.userId.slice() : undefined,
    nick: typeof raw.nick === "string" ? raw.nick : undefined,
    enrolledAt: raw.enrolledAt,
    lastUsedAt: typeof raw.lastUsedAt === "number" &&
        Number.isFinite(raw.lastUsedAt)
      ? raw.lastUsedAt
      : undefined,
    attachment,
    transports: transports === undefined || transports.length === 0
      ? undefined
      : transports,
    aaguid: raw.aaguid instanceof Uint8Array ? raw.aaguid.slice() : undefined,
    enrolledOs,
  };
}

/** Read a keyring from IDB structured-clone output. */
export function decodeKeyring(raw: unknown): Keyring | undefined {
  if (!isRecord(raw)) return undefined;
  if (!(raw.salt instanceof Uint8Array) || !Array.isArray(raw.entries)) {
    return undefined;
  }
  const entries: KeyringEntry[] = [];
  for (const row of raw.entries) {
    const e = decodeEntry(row);
    if (e !== undefined) entries.push(e);
  }
  if (entries.length === 0) return undefined;
  return { salt: raw.salt.slice(), entries };
}

function toRow(e: KeyringEntry): KeyringRow {
  return {
    type: "prf",
    credId: e.credId.slice(),
    userId: e.userId === undefined ? undefined : e.userId.slice(),
    nick: e.nick,
    enrolledAt: e.enrolledAt,
    lastUsedAt: e.lastUsedAt,
    attachment: e.attachment,
    transports: e.transports === undefined ? undefined : [...e.transports],
    aaguid: e.aaguid === undefined ? undefined : e.aaguid.slice(),
    enrolledOs: e.enrolledOs,
  };
}

/** Cred ids of every keyring entry. */
export function keyringCredIds(ring: Keyring | undefined): Uint8Array[] {
  if (ring === undefined) return [];
  return ring.entries
    .filter((e) => e.credId.byteLength > 0)
    .map((e) => e.credId.slice());
}

function upsertEntry(ring: Keyring, next: KeyringEntry): ValStat<Keyring> {
  const [entries, st] = cloneEntries(ring.entries);
  if (st !== Status.Success) return err(st);
  const i = entries.findIndex((e) => bytesEqual(e.credId, next.credId));
  if (i >= 0) {
    const prev = entries[i];
    entries[i] = {
      ...next,
      enrolledAt: prev?.enrolledAt ?? next.enrolledAt,
      nick: next.nick ?? prev?.nick,
    };
  } else {
    entries.push(next);
  }
  return ok({ salt: ring.salt.slice(), entries });
}

function touchEntry(
  ring: Keyring,
  credId: Uint8Array,
): ValStat<Keyring | undefined> {
  if (credId.byteLength === 0) return ok(undefined);
  const i = ring.entries.findIndex((e) => bytesEqual(e.credId, credId));
  if (i < 0) return ok(undefined);
  const [entries, st] = cloneEntries(ring.entries);
  if (st !== Status.Success) return err(st);
  const cur = entries[i];
  if (cur === undefined) return err(Status.NotFound);
  entries[i] = { ...cur, lastUsedAt: Date.now() };
  return ok({ salt: ring.salt.slice(), entries });
}

// Well-known AAGUIDs (unverified — display only).
const AAGUID_APPLE = hex16("fbfc3007154e4ecc8c0b6e020557d7bd");
const AAGUID_GPM = hex16("ea9b8d664d011d213ce4b6b48cb575d4");
const AAGUID_HELLO = hex16("08987058cadc4b81b6e130de50dcbe96");
const AAGUID_YUBI_5 = hex16("2fc0579f811347eab116bb5a8db9202a");

function hex16(h: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function aaguidName(id: Uint8Array | undefined): string | undefined {
  if (id === undefined || id.byteLength !== 16) return undefined;
  if (bytesEqual(id, AAGUID_APPLE)) return "Apple Passkey";
  if (bytesEqual(id, AAGUID_GPM)) return "GPM";
  if (bytesEqual(id, AAGUID_HELLO)) return "Windows Hello";
  if (bytesEqual(id, AAGUID_YUBI_5)) return "YubiKey";
  return undefined;
}

function roaming(row: KeyringRow): boolean {
  if (row.attachment === "cross-platform") return true;
  if (row.transports === undefined) return false;
  return row.transports.some((t) => t === "usb" || t === "nfc" || t === "ble");
}

/** Inferred kind for UI. Not attested. */
export function keyringKind(row: KeyringRow): string {
  const named = aaguidName(row.aaguid);
  if (named !== undefined) return named;
  if (roaming(row)) return "Security key";
  if (row.attachment === "platform") {
    if (row.enrolledOs === "ios" || row.enrolledOs === "macos") {
      return "Apple Passkey";
    }
    if (row.enrolledOs === "android") return "GPM";
    if (row.enrolledOs === "windows") return "Windows Hello";
    return "Passkey";
  }
  return "Passkey";
}

function credTail(id: Uint8Array): string {
  if (id.byteLength === 0) return "";
  const n = Math.min(4, id.byteLength);
  let hex = "";
  for (let i = id.byteLength - n; i < id.byteLength; i++) {
    const b = id[i];
    if (b === undefined) continue;
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Display label: nick, else inferred kind + short cred id. */
export function keyringLabel(row: KeyringRow): string {
  if (row.nick !== undefined && row.nick !== "") return row.nick;
  const kind = keyringKind(row);
  const tail = credTail(row.credId);
  return tail === "" ? kind : `${kind} ${tail}`;
}
