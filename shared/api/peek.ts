import { hashBytes, Status } from "../consts.ts";
import { ICodecStruct } from "../codec.ts";
import { IAuthenticatedEndpoint } from "../endpoint.ts";
import { IBagPeekItem, peekItemCodec } from "../codecs/peekItem.ts";
import { authTimestampCodec } from "../codecs/authTimestamp.ts";
import { validateAuthTimestamp } from "../auth.ts";
import { asHostRlm, type HostRlm } from "../crypto/derivation.ts";
import { err, ok } from "../valstat.ts";

/** One realm cursor: that rlm, and the last seq the client has in it. */
export interface IPeekCursor {
  rlm: HostRlm;
  seq: number;
}

// One PEEK cursor: rlm, then the seq the client already has.
export const peekCursorCodec: ICodecStruct<IPeekCursor> = {
  encode(enc, cursor) {
    if (cursor.rlm.byteLength !== hashBytes) return Status.InvalidParam;
    enc.writeBytes(cursor.rlm);
    return enc.writeVarInt(cursor.seq);
  },
  decode(dec) {
    const [raw, rs] = dec.readBytes(hashBytes);
    if (rs !== Status.Success) return err(rs);
    const [rlm, bst] = asHostRlm(raw);
    if (bst !== Status.Success) return err(bst);
    const [seq, ss] = dec.readVarInt();
    if (ss !== Status.Success) return err(ss);
    return ok({ rlm, seq });
  },
};

export const peekEnd: IAuthenticatedEndpoint<
  IPeekCursor,
  IBagPeekItem[]
> = {
  async encodeReq(_client, _identity, authTS, cursor, reqEnc) {
    const s1 = reqEnc.writeStruct(authTimestampCodec, authTS);
    if (s1 !== Status.Success) return s1;
    return reqEnc.writeStruct(peekCursorCodec, cursor);
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

    const [cursor, cs] = reqDec.readStruct(peekCursorCodec);
    if (cs !== Status.Success) return cs;
    if (!reqDec.done()) return Status.ExtraBodyContent;

    const [items, listStatus] = await storage.listHeads(
      pubKey,
      cursor.rlm,
      cursor.seq,
    );
    if (listStatus !== Status.Success) return listStatus;
    return respEnc.writeStructs(peekItemCodec, items);
  },
  decodeResp(respDec) {
    return respDec.readStructs(peekItemCodec);
  },
};
