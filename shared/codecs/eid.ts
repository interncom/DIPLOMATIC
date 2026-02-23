import { Encoder, ICodecStruct } from "../codec.ts";
import { Status } from "../consts.ts";
import { err, ok, ValStat } from "../valstat.ts";
import { EntityID } from "../types.ts";

// An EID (EntityID) is a composite.
// It has an ID component, typically random.
// And also a time component, indicating its point of creation.
export interface IEntityID {
  id: Uint8Array;
  ts: Date;
}

export const eidCodec: ICodecStruct<IEntityID> = {
  encode(enc, eid) {
    const s1 = enc.writeVarBytes(eid.id);
    if (s1 !== Status.Success) return s1;
    const s2 = enc.writeDate(eid.ts);
    if (s2 !== Status.Success) return s2;
    return Status.Success;
  },
  decode(dec) {
    const [id, s1] = dec.readVarBytes();
    if (s1 !== Status.Success) return err(s1);
    const [ts, s2] = dec.readDate();
    if (s2 !== Status.Success) return err(s2);
    return ok({ id: id as EntityID, ts });
  },
};

export function makeEID(eidObj: IEntityID): ValStat<EntityID> {
  const encEid = new Encoder();
  const stat = encEid.writeStruct(eidCodec, eidObj);
  if (stat !== Status.Success) {
    return err(stat);
  }
  const eid = encEid.result() as EntityID;
  return ok(eid);
}

export async function genSingletonEID(id: Uint8Array): Promise<ValStat<EntityID>> {
  const ts = new Date(0);
  return makeEID({ id, ts });
}
