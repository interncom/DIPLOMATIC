// UV largeBlob write for Enclave. Not a confidentiality boundary vs the OS.
// Only enclave.ts may import this module. writeLargeBlob may receive
// IdentityBundle wire (seed‖hosts); never return that plaintext.

import { Status } from "../consts.ts";
import { MASTER_SEED_LEN } from "../seed.ts";
import { ok, type ValStat } from "../valstat.ts";
import {
  asPublicKeyCredential,
  checkWebAuthn,
  copyToArrayBuffer,
  noteWebAuthnError,
  resolveWebAuthnRpId,
  tryFocus,
  WEBAUTHN_CHAL_LEN,
  WEBAUTHN_CRED_TYPE,
  webAuthnNotFocused,
  whenVisible,
} from "../webauthn/common.ts";
import {
  largeBlobCreateCred,
  type LargeBlobCreateOpts,
  type LargeBlobRp,
} from "../webauthn/largeBlob.ts";
import { randomBytesArrayBuffer } from "./entropy.ts";

// DOM lib used by pkg/cli tsc lags largeBlob (see webauthn-largeblob.d.ts).
type LbIn = AuthenticationExtensionsClientInputs & {
  largeBlob?: { write?: BufferSource };
};
type LbOut = AuthenticationExtensionsClientOutputs & {
  largeBlob?: { written?: boolean };
};

// Credential to write: opts.credId, or a newly created largeBlob credential.
export async function largeBlobCredId(
  opts?: LargeBlobCreateOpts & { credId?: Uint8Array },
): Promise<ValStat<Uint8Array>> {
  if (opts?.credId !== undefined) return ok(opts.credId);
  return largeBlobCreateCred(opts);
}

// UV-writes largeBlob bytes. credId is not seed; data may be IdentityBundle wire.
// Zeros the local copy before return.
export async function writeLargeBlob(
  credId: Uint8Array,
  data: Uint8Array,
  opts?: LargeBlobRp,
): Promise<Status> {
  const wst = checkWebAuthn();
  if (wst !== Status.Success) return wst;
  const [rpId, rst] = resolveWebAuthnRpId(opts);
  if (rst !== Status.Success) return rst;
  if (rpId === undefined) return Status.MissingParam;

  await whenVisible();
  const write = new Uint8Array(data.byteLength);
  write.set(data);
  const extensions: LbIn = { largeBlob: { write: write.buffer } };
  const req: CredentialRequestOptions = {
    publicKey: {
      challenge: randomBytesArrayBuffer(WEBAUTHN_CHAL_LEN),
      rpId,
      allowCredentials: [
        { type: WEBAUTHN_CRED_TYPE, id: copyToArrayBuffer(credId) },
      ],
      userVerification: "required",
      extensions,
      ...(opts?.hints !== undefined ? { hints: opts.hints } : {}),
    },
  };
  let cred: Credential | null;
  try {
    try {
      cred = await navigator.credentials.get(req);
    } catch (e) {
      if (!webAuthnNotFocused(e)) {
        noteWebAuthnError(e);
        return Status.WebAuthnError;
      }
      tryFocus();
      try {
        cred = await navigator.credentials.get(req);
      } catch (e2) {
        noteWebAuthnError(e2);
        return Status.WebAuthnError;
      }
    }
  } catch (e) {
    noteWebAuthnError(e);
    return Status.WebAuthnError;
  } finally {
    write.fill(0);
  }

  const [pk, pst] = asPublicKeyCredential(cred);
  if (pst !== Status.Success) return pst;
  if (pk === undefined) return Status.InvalidResponse;
  const ext: LbOut = pk.getClientExtensionResults();
  if (ext.largeBlob?.written !== true) {
    return Status.WebAuthnError;
  }
  return Status.Success;
}

// UV-overwrites largeBlob with zeros so a stored seed cannot be read back.
export function wipeLargeBlob(
  credId: Uint8Array,
  opts?: LargeBlobRp,
): Promise<Status> {
  return writeLargeBlob(credId, new Uint8Array(MASTER_SEED_LEN), opts);
}
