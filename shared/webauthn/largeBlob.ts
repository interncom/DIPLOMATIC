// WebAuthn largeBlob extension: opaque byte create / write / read (UV).
// Not a confidentiality boundary vs the OS — only vs hosts / casual disk.
//
// This is browser I/O plumbing, not crypto. Enclave calls it for seed persist
// (encode stays inside Enclave). Apps may use it for non-seed opaque blobs;
// never pass unencrypted seed from app code into write.

import { Status } from "../consts.ts";
import { randomBytesArrayBuffer } from "../crypto/entropy.ts";
import { err, ok, type ValStat } from "../valstat.ts";
import {
  asPublicKeyCredential,
  bufferSourceToUint8,
  checkWebAuthn,
  copyToArrayBuffer,
  resolveWebAuthnRpId,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_PUB_KEY_PARAMS,
  webAuthnExtensionCapable,
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

// DOM lib typings lag largeBlob; cast extension bags (see largeBlob.d.ts).
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
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
        rp: { id: rpId, name: opts?.rpName ?? "DIPLOMATIC" },
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
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
  if (pk === undefined) return err(Status.InvalidResponse);
  const ext = pk.getClientExtensionResults() as ExtOut;
  if (ext.largeBlob?.supported !== true) {
    return err(Status.HostError);
  }
  return ok(new Uint8Array(pk.rawId));
}

/** UV write of opaque bytes to largeBlob. */
export async function largeBlobWrite(
  credId: Uint8Array,
  data: Uint8Array,
  opts?: LargeBlobRp,
): Promise<Status> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return wst;
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return rst;
  if (rpId === undefined) return Status.MissingParam;

  const extensions: ExtIn = {
    largeBlob: { write: copyToArrayBuffer(data) },
  };

  let cred: Credential | null;
  try {
    cred = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
        rpId,
        allowCredentials: [
          { type: "public-key", id: copyToArrayBuffer(credId) },
        ],
        userVerification: "required",
        extensions: extensions as AuthenticationExtensionsClientInputs,
        ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
      },
    });
  } catch {
    return Status.HostError;
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return pst;
  if (pk === undefined) return Status.InvalidResponse;
  const ext = pk.getClientExtensionResults() as ExtOut;
  if (ext.largeBlob?.written !== true) {
    return Status.HostError;
  }
  return Status.Success;
}

/** UV read from largeBlob; `credId` undefined = discoverable assertion. */
export async function largeBlobRead(
  credId: Uint8Array | undefined,
  opts?: LargeBlobRp,
): Promise<ValStat<{ blob: Uint8Array; credId: Uint8Array }>> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return err(wst);
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return err(rst);
  if (rpId === undefined) return err(Status.MissingParam);

  const extensions: ExtIn = { largeBlob: { read: true } };

  let cred: Credential | null;
  try {
    const publicKey: ReqOpts = {
      challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
      rpId,
      userVerification: "required",
      extensions: extensions as AuthenticationExtensionsClientInputs,
    };
    if (opts?.hints !== undefined) publicKey.hints = opts.hints;
    if (credId !== undefined) {
      publicKey.allowCredentials = [
        { type: "public-key", id: copyToArrayBuffer(credId) },
      ];
    }
    cred = await navigator.credentials.get({ publicKey });
  } catch {
    return err(Status.HostError);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return err(pst);
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
