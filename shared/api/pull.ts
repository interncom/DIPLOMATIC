import { validateAuthTimestamp } from "../auth.ts";
import { ICodecStruct } from "../codec.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { type IBagPullItem, pullItemCodec } from "../codecs/pullItem.ts";
import { hashBytes, Status } from "../consts.ts";
import { asHostRlm, type HostRlm } from "../crypto/derivation.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { err, ok } from "../valstat.ts";

/** One realm, and the seqs to fetch in it. */
export interface IPullReq {
  rlm: HostRlm;
  seqs: number[];
}

// One PULL: rlm, then each seq in that realm.
export const pullReqCodec: ICodecStruct<IPullReq> = {
  encode(enc, req) {
    if (req.rlm.byteLength !== hashBytes) return Status.InvalidParam;
    enc.writeBytes(req.rlm);
    for (const seq of req.seqs) {
      const s = enc.writeVarInt(seq);
      if (s !== Status.Success) return s;
    }
    return Status.Success;
  },
  decode(dec) {
    const [raw, rs] = dec.readBytes(hashBytes);
    if (rs !== Status.Success) return err(rs);
    const [rlm, bst] = asHostRlm(raw);
    if (bst !== Status.Success) return err(bst);
    const seqs: number[] = [];
    while (!dec.done()) {
      const [seq, ss] = dec.readVarInt();
      if (ss !== Status.Success) return err(ss);
      seqs.push(seq);
    }
    return ok({ rlm, seqs });
  },
};

export const pullEnd: IAuthenticatedEndpoint<
  IPullReq,
  IBagPullItem[]
> = {
  async encodeReq(_client, _identity, authTS, req, reqEnc): Promise<Status> {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    return reqEnc.writeStruct(pullReqCodec, req);
  },
  async handleReq(host, reqDec, respEnc) {
    const { clock, crypto, storage } = host;

    const [authTS, s] = reqDec.readStruct(authTimestampCodec);
    if (s !== Status.Success) return s;
    const validStatus = await validateAuthTimestamp(authTS, crypto, clock);
    if (validStatus !== Status.Success) return validStatus;
    const { pubKey } = authTS;

    const [hasUser, hasStatus] = await storage.hasUser(pubKey);
    if (hasStatus !== Status.Success) return hasStatus;
    if (!hasUser) return Status.UserNotRegistered;

    const [req, rs] = reqDec.readStruct(pullReqCodec);
    if (rs !== Status.Success) return rs;

    console.info(`PULL: ${req.seqs.length} bags`);

    const [bodies, getStatus] = await storage.getBodies(
      pubKey,
      req.rlm,
      req.seqs,
    );
    if (getStatus !== Status.Success) return getStatus;
    if (!bodies) return Status.StorageError;

    for (const { seq, bodyCph } of bodies) {
      const item: IBagPullItem = { seq, bodyCph };
      const itemStatus = respEnc.writeStruct(pullItemCodec, item);
      if (itemStatus !== Status.Success) return itemStatus;
    }
    return Status.Success;
  },
  decodeResp(respDec) {
    return respDec.readStructs(pullItemCodec);
  },
};
