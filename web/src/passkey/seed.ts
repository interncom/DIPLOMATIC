// Master seed via WebAuthn largeBlob (OS-held passkey storage).
// Not a confidentiality boundary vs the OS — only vs hosts / casual disk.

import libsodiumCrypto from "../crypto";
import { Enclave } from "../shared/crypto/enclave";
import type { MasterSeed } from "../shared/types";
import type { ISeedStore, SetSeedOpts } from "../types";

const SEED_LEN = 32;
const CHAL_LEN = 32;

export type LargeBlobRp = {
  rpId?: string;
  rpName?: string;
};

/**
 * Multi-part public suffixes where eTLD+1 needs three labels
 * (e.g. foo.example.co.uk → example.co.uk). Not a full PSL.
 */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "com.br",
  "com.mx",
  "co.kr",
  "com.sg",
  "co.in",
  "com.hk",
  "github.io",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
]);

function isIpHost(host: string): boolean {
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (with or without brackets)
  if (host.includes(":")) return true;
  return false;
}

/**
 * Stable WebAuthn RP ID for a hostname: registrable domain (eTLD+1) when
 * possible, else the hostname itself.
 *
 * Using the full hostname (e.g. life.example.com) scopes credentials to that
 * host only. Safari/Apple Passwords often present the site as the apex domain;
 * Chrome + security keys tend to store whatever rpId we pass. Defaulting to
 * eTLD+1 keeps platform + roaming authenticators on the same RP ID across
 * subdomains and browsers.
 *
 * localhost / IPs are returned unchanged (valid only for those origins).
 */
export function defaultWebAuthnRpId(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    return host || "localhost";
  }
  if (isIpHost(host)) return host;

  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;

  const last2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  if (MULTI_PART_SUFFIXES.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return last2;
}

/** Fresh ArrayBuffer-backed view (DOM BufferSource typing). */
function buf(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function copyBuf(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.byteLength);
  out.set(src);
  return out;
}

/** Prefer ArrayBuffer for WebAuthn BufferSource (Safari is picky with some views). */
function asArrayBuffer(src: Uint8Array): ArrayBuffer {
  const copy = copyBuf(src);
  return copy.buffer;
}

function asSeed(bytes: Uint8Array): MasterSeed {
  if (bytes.byteLength !== SEED_LEN) {
    throw new Error(`largeBlob: seed must be ${SEED_LEN} bytes`);
  }
  return bytes as MasterSeed;
}

function rpIdOf(opts?: LargeBlobRp): string {
  if (opts?.rpId !== undefined) return opts.rpId;
  if (typeof location === "undefined") {
    throw new Error("largeBlob: rpId required outside browser");
  }
  return defaultWebAuthnRpId(location.hostname);
}

function assertWebAuthn(): void {
  if (
    typeof navigator === "undefined" ||
    !navigator.credentials ||
    typeof PublicKeyCredential === "undefined"
  ) {
    throw new Error("largeBlob: WebAuthn unavailable");
  }
}

function asPkCred(cred: Credential | null): PublicKeyCredential {
  if (
    cred === null ||
    cred.type !== "public-key" ||
    !("rawId" in cred) ||
    typeof (cred as PublicKeyCredential).getClientExtensionResults !==
      "function"
  ) {
    throw new Error("largeBlob: expected public-key credential");
  }
  return cred as PublicKeyCredential;
}

/**
 * Apple Safari / WebKit (desktop Safari, iOS Safari, Safari dock/home-screen PWAs).
 * Chromium and other UAs embed "Safari" in the UA and must be excluded.
 */
function isAppleSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Chrome, Edge, Firefox, Opera, and their iOS wrappers all include Safari tokens.
  if (
    /Chrom(e|ium)|Edg\/|EdgiOS|OPR\/|Firefox|FxiOS|CriOS|Android/.test(ua)
  ) {
    return false;
  }
  if (/Safari\//.test(ua)) return true;
  // Standalone WebKit PWAs sometimes omit "Safari/" but keep Apple vendor + WebKit.
  return (
    navigator.vendor === "Apple Computer, Inc." && /AppleWebKit/.test(ua)
  );
}

/**
 * Best-effort capability probe (not all UAs expose this accurately).
 *
 * Safari 17+ supports largeBlob on platform authenticators but often omits or
 * mis-reports `extension:largeBlob` from {@link PublicKeyCredential.getClientCapabilities}.
 * Treat Apple Safari as capable so UI can offer enroll; create still checks
 * `largeBlob.supported` after the ceremony.
 */
export async function largeBlobCapable(): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined") return false;
  // Important platform: try create even when capability advertisement is wrong.
  if (isAppleSafari()) return true;
  const getCaps = PublicKeyCredential.getClientCapabilities;
  if (typeof getCaps !== "function") return true;
  const caps = await getCaps.call(PublicKeyCredential);
  const key = "extension:largeBlob";
  if (key in caps) return caps[key] === true;
  return true;
}

export type LargeBlobCreateOpts = LargeBlobRp & {
  userName?: string;
  /**
   * Omit (default) to allow both platform (Hello/Touch ID) and roaming
   * authenticators (YubiKey). Set only if you intentionally restrict.
   */
  authenticatorAttachment?: AuthenticatorAttachment;
};

/**
 * Create a discoverable credential with largeBlob support.
 * Does **not** write the seed — call {@link writeLargeBlobSeed} from a
 * **separate user gesture** (second click). Safari / WebKit will not reliably
 * run two WebAuthn ceremonies from one button press; chaining create→write
 * leaves empty passkeys (see blobviem / nsatragno largeBlob demos).
 *
 * On Apple Safari, defaults to `authenticatorAttachment: "platform"` so
 * iCloud Keychain is preferred (Apple largeBlob is platform-oriented).
 * Pass `authenticatorAttachment: "cross-platform"` for security keys.
 */
export async function createLargeBlobCred(
  opts?: LargeBlobCreateOpts,
): Promise<Uint8Array> {
  assertWebAuthn();
  const name = opts?.userName ?? "diplomatic-seed";
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
  };
  if (opts?.authenticatorAttachment !== undefined) {
    selection.authenticatorAttachment = opts.authenticatorAttachment;
  } else if (isAppleSafari()) {
    // iCloud Keychain largeBlob path; avoids empty non-blob roaming creates.
    selection.authenticatorAttachment = "platform";
  }
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: buf(CHAL_LEN),
      rp: { id: rpIdOf(opts), name: opts?.rpName ?? "DIPLOMATIC" },
      user: {
        id: buf(16),
        name,
        displayName: name,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: selection,
      // "preferred" matches the canonical nsatragno demo; we still reject when
      // supported !== true so empty passkeys are not treated as success.
      extensions: { largeBlob: { support: "preferred" } },
    },
  });
  const pk = asPkCred(cred);
  const ext = pk.getClientExtensionResults();
  if (ext.largeBlob?.supported !== true) {
    // create() often still succeeds: support is not always enforced by the
    // client. Empty OS passkey may remain — delete it in Passwords/OS UI.
    throw new Error(
      "largeBlob: unsupported by authenticator. " +
        "Use Apple Passwords / iCloud Keychain (Safari platform) or a " +
        "largeBlob-capable security key in Chrome. " +
        "An empty passkey may have been created — remove it in Passwords if listed.",
    );
  }
  return new Uint8Array(pk.rawId);
}

/**
 * Persist seed on an existing largeBlob-capable credential.
 * Must be invoked from its **own** user gesture (not chained after create
 * in the same click handler on Safari).
 *
 * Spec: allowCredentials must contain exactly one credential for write.
 */
export async function writeLargeBlobSeed(
  credId: Uint8Array,
  seed: MasterSeed,
  opts?: LargeBlobRp,
): Promise<void> {
  assertWebAuthn();
  asSeed(seed);
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: buf(CHAL_LEN),
      rpId: rpIdOf(opts),
      allowCredentials: [
        { type: "public-key", id: asArrayBuffer(credId) },
      ],
      userVerification: "required",
      extensions: { largeBlob: { write: asArrayBuffer(seed) } },
    },
  });
  const ext = asPkCred(cred).getClientExtensionResults();
  if (ext.largeBlob?.written !== true) {
    throw new Error(
      "largeBlob: write not accepted. " +
        "On Safari, create and write must be two separate button clicks. " +
        "Confirm the passkey is iCloud Keychain / platform, not a manager without largeBlob.",
    );
  }
}

/** Overwrite largeBlob with 32 zero bytes (destroys stored seed material). UV required. */
export async function clearLargeBlobSeed(
  credId: Uint8Array,
  opts?: LargeBlobRp,
): Promise<void> {
  const zeros = new Uint8Array(SEED_LEN) as MasterSeed;
  await writeLargeBlobSeed(credId, zeros, opts);
}

export type LargeBlobUnlock = {
  seed: MasterSeed;
  /** Authenticator credential id — app should persist for faster local unlock. */
  credId: Uint8Array;
};

/**
 * Read seed from largeBlob on a known credential (user verification required).
 */
export async function readLargeBlobSeed(
  credId: Uint8Array,
  opts?: LargeBlobRp,
): Promise<MasterSeed> {
  const out = await readLargeBlobUnlock(credId, opts);
  return out.seed;
}

/**
 * Same as {@link readLargeBlobSeed} but also returns the credential id used.
 */
export async function readLargeBlobUnlock(
  credId: Uint8Array,
  opts?: LargeBlobRp,
): Promise<LargeBlobUnlock> {
  assertWebAuthn();
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: buf(CHAL_LEN),
      rpId: rpIdOf(opts),
      allowCredentials: [
        { type: "public-key", id: asArrayBuffer(credId) },
      ],
      userVerification: "required",
      extensions: { largeBlob: { read: true } },
    },
  });
  return largeBlobUnlockFromCred(asPkCred(cred));
}

/**
 * Discoverable assertion + largeBlob read (no local credential id).
 *
 * Omits `allowCredentials` so the platform can offer resident keys for this
 * rpId — including iCloud-synced passkeys. Returns seed and `credId` so the
 * app can cache the id for later non-discoverable unlocks.
 */
export async function discoverLargeBlobSeed(
  opts?: LargeBlobRp,
): Promise<LargeBlobUnlock> {
  assertWebAuthn();
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: buf(CHAL_LEN),
      rpId: rpIdOf(opts),
      userVerification: "required",
      extensions: { largeBlob: { read: true } },
    },
  });
  return largeBlobUnlockFromCred(asPkCred(cred));
}

function largeBlobUnlockFromCred(pk: PublicKeyCredential): LargeBlobUnlock {
  const blob = pk.getClientExtensionResults().largeBlob?.blob;
  if (blob === undefined) {
    throw new Error(
      "largeBlob: missing blob (credential has no seed storage, or largeBlob did not sync)",
    );
  }
  const seedBytes = new Uint8Array(blob);
  // Wiped credentials store 32 zero bytes — treat as empty.
  if (seedBytes.every((b) => b === 0)) {
    throw new Error("largeBlob: seed was cleared");
  }
  return {
    seed: asSeed(seedBytes),
    credId: new Uint8Array(pk.rawId),
  };
}

/**
 * Create credential then write seed in one call.
 *
 * **Safari/WebKit:** prefer {@link createLargeBlobCred} + {@link writeLargeBlobSeed}
 * from **two separate clicks**. Chaining both after one gesture often creates a
 * passkey without a blob (`written` false / later `missing blob` on read).
 *
 * Returns credential id — persist it; the seed lives on the authenticator.
 */
export async function storeSeedLargeBlob(
  seed: MasterSeed,
  opts?: LargeBlobCreateOpts,
): Promise<Uint8Array> {
  const credId = await createLargeBlobCred(opts);
  await writeLargeBlobSeed(credId, seed, opts);
  return credId;
}

/**
 * ISeedStore backed by largeBlob.
 * - {@link save} creates (or reuses) cred + writes seed (gestures).
 * - {@link load} returns in-memory enclave only; call {@link unlock} after restart.
 * - Local {@link credId} must be persisted by the app across sessions.
 * - {@link wipe} overwrites largeBlob with zeros (UV), then drops memory + credId.
 *   Does not delete the WebAuthn credential from the authenticator.
 */
export class PasskeySeedStore implements ISeedStore {
  #enclave: Enclave | undefined;
  #credId: Uint8Array | undefined;
  #rpId: string | undefined;
  #rpName: string | undefined;

  constructor(opts?: LargeBlobRp & { credId?: Uint8Array }) {
    this.#rpId = opts?.rpId;
    this.#rpName = opts?.rpName;
    if (opts?.credId !== undefined) {
      this.#credId = opts.credId.slice();
    }
  }

  get credId(): Uint8Array | undefined {
    if (this.#credId === undefined) return undefined;
    return this.#credId.slice();
  }

  setCredId(credId: Uint8Array | undefined): void {
    this.#credId = credId === undefined ? undefined : credId.slice();
  }

  async save(seed: MasterSeed, opts?: SetSeedOpts): Promise<Enclave> {
    // Default memory-only; persist:true writes largeBlob (this store's durable path).
    if (opts?.persist !== true) {
      this.#enclave = new Enclave(seed, libsodiumCrypto);
      return this.#enclave;
    }
    const rp = { rpId: this.#rpId, rpName: this.#rpName };
    let id = this.#credId;
    if (id === undefined) {
      id = await createLargeBlobCred(rp);
      this.#credId = id;
    }
    await writeLargeBlobSeed(id, seed, rp);
    this.#enclave = new Enclave(seed, libsodiumCrypto);
    return this.#enclave;
  }

  async load(): Promise<Enclave | void> {
    return this.#enclave;
  }

  /** User-gesture unlock after cold start (needs {@link credId}). */
  async unlock(): Promise<Enclave> {
    const id = this.#credId;
    if (id === undefined) {
      throw new Error("largeBlob: no credential id");
    }
    const seed = await readLargeBlobSeed(id, { rpId: this.#rpId });
    this.#enclave = new Enclave(seed, libsodiumCrypto);
    return this.#enclave;
  }

  async wipe(): Promise<void> {
    const id = this.#credId;
    if (id !== undefined) {
      await clearLargeBlobSeed(id, { rpId: this.#rpId });
    }
    this.#enclave = undefined;
    this.#credId = undefined;
  }
}
