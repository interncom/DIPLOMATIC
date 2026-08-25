// WebAuthn largeBlob extension: opaque byte create / write / read (UV).
// Not a confidentiality boundary vs the OS — only vs hosts / casual disk.
// WebAuthn “authenticator” = binding key: IKM / blob store, not authn/authz.
//
// This is browser I/O plumbing, not crypto. Seed persist/clear write lives
// in enclave.ts (Iron Law). This module is create / read / capability probe.

import { Status } from "../consts.ts";
import { randomBytesArrayBuffer } from "../crypto/entropy.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import {
  asPublicKeyCredential,
  bufferSourceToUint8,
  checkWebAuthn,
  copyToArrayBuffer,
  DEFAULT_WEBAUTHN_RP_NAME,
  noteWebAuthnError,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_CRED_TYPE,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnCreate,
  webAuthnExtensionCapable,
  webAuthnGet,
  type WebAuthnHint,
  type WebAuthnRp,
} from "./common.ts";

type ReqOpts = PublicKeyCredentialRequestOptions & {
  hints?: WebAuthnHint[];
};

export type LargeBlobRp = WebAuthnRp;

export type LargeBlobCreateOpts = LargeBlobRp & {
  userName?: string;
  authenticatorAttachment?: string;
};

// DOM lib typings lag largeBlob; cast extension bags (see webauthn-largeblob.d.ts).
type ExtIn = AuthenticationExtensionsClientInputs & {
  largeBlob?: { support?: string; write?: BufferSource; read?: boolean };
};
type ExtOut = AuthenticationExtensionsClientOutputs & {
  largeBlob?: {
    supported?: boolean;
    written?: boolean;
    /** Spec: ArrayBuffer; some UAs return a view. */
    blob?: BufferSource;
  };
};

/** Best-effort capability probe. */
export function largeBlobCapable(): Promise<boolean> {
  return webAuthnExtensionCapable("extension:largeBlob");
}

/** Create discoverable largeBlob-capable credential; returns credential id. */
export async function largeBlobCreateCred(
  opts?: LargeBlobCreateOpts,
): Promise<ValStat<Uint8Array>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  const name = opts?.userName ?? "diplomatic-seed";
  const selection: AuthenticatorSelectionCriteria = {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "required",
  };
  if (opts?.authenticatorAttachment !== undefined) {
    selection.authenticatorAttachment = opts
      .authenticatorAttachment as AuthenticatorAttachment;
  }

  const extensions: ExtIn = { largeBlob: { support: "required" } };

  let cred: Credential | null;
  try {
    cred = await webAuthnCreate({
      publicKey: {
        challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
        rp: { id: rpId, name: opts?.rpName ?? DEFAULT_WEBAUTHN_RP_NAME },
        user: {
          id: randomBytesArrayBuffer(16),
          name,
          displayName: name,
        },
        pubKeyCredParams: WEBAUTHN_PUB_KEY_PARAMS,
        authenticatorSelection: selection,
        extensions: extensions as AuthenticationExtensionsClientInputs,
        ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
      },
    });
  } catch (e) {
    noteWebAuthnError(e);
    return err(Status.WebAuthnError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as ExtOut;
  if (ext.largeBlob?.supported !== true) {
    return err(Status.WebAuthnError);
  }
  return ok(new Uint8Array(pk.rawId));
}

/** `get()` with optional hints / allow list. UV preferred: required fails closed
 * on Android when USB PIN is not wired (instant NotAllowedError, no picker). */
async function getAssertion(
  rpId: string,
  opts?: LargeBlobRp,
  credId?: Uint8Array,
  extensions?: ExtIn,
): Promise<ValStat<PublicKeyCredential>> {
  const publicKey: ReqOpts = {
    challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
    rpId,
    userVerification: "preferred",
  };
  if (opts?.hints !== undefined) publicKey.hints = opts.hints;
  if (credId !== undefined) {
    publicKey.allowCredentials = [
      { type: WEBAUTHN_CRED_TYPE, id: copyToArrayBuffer(credId) },
    ];
  }
  if (extensions !== undefined) {
    publicKey.extensions = extensions as AuthenticationExtensionsClientInputs;
  }
  let cred: Credential | null;
  try {
    cred = await webAuthnGet({ publicKey });
  } catch (e) {
    noteWebAuthnError(e);
    return err(Status.WebAuthnError);
  }
  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  return ok(pk);
}

/** UV read from largeBlob; `credId` undefined = discoverable then targeted read. */
// Android Credential Manager aborts a discoverable get that requests
// largeBlob.read (no USB picker). Pick the key first, then read.
export async function largeBlobRead(
  credId: Uint8Array | undefined,
  opts?: LargeBlobRp,
): Promise<ValStat<{ blob: Uint8Array; credId: Uint8Array }>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  let id = credId;
  if (id === undefined) {
    let [picked, pst] = await getAssertion(rpId, opts);
    if (pst !== Status.Success && opts?.hints !== undefined) {
      // hints:security-key with no provider is an instant NotAllowedError.
      [picked, pst] = await getAssertion(rpId, {
        rpId: opts.rpId,
        rpName: opts.rpName,
      });
    }
    if (pst !== Status.Success) return err(pst);
    if (picked === undefined) return err(Status.InvalidResponse);
    id = new Uint8Array(picked.rawId);
  }

  const [pk, gst] = await getAssertion(rpId, opts, id, {
    largeBlob: { read: true },
  });
  if (gst !== Status.Success) return err(gst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as ExtOut;
  const lb = ext.largeBlob;
  // Assertion can succeed without the extension (wrong cred / no largeBlob
  // support on this path) — that is MissingBody, not InvalidResponse.
  if (lb === undefined || lb.blob === undefined) {
    return err(Status.MissingBody);
  }
  const blob = bufferSourceToUint8(lb.blob);
  if (blob.byteLength === 0) return err(Status.MissingBody);
  return ok({
    blob,
    credId: new Uint8Array(pk.rawId),
  });
}
