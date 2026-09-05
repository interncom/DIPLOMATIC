import { IClock } from "./clock.ts";
import { Decoder, Encoder } from "./codec.ts";
import { eidCodec, IEntityID, makeEID } from "./codecs/eid.ts";
import { Status } from "./consts.ts";
import { TypedEventEmitter } from "./events.ts";
import {
  EntityID,
  IMessage,
  IStateManager,
  IUpsertMessage,
  SerializedContent,
} from "./types.ts";
import { err, ok, ValStat } from "./valstat.ts";

export async function genSingletonUpsert(
  type: string,
  clk: IClock,
  content: Uint8Array,
  ctr = 0,
): Promise<ValStat<IUpsertMessage>> {
  const now = clk.now();

  const encText = new Encoder();
  const statText = encText.writeVarString(type);
  if (statText !== Status.Success) {
    return err(statText);
  }
  const textBytes = encText.result();

  const eidObj: IEntityID = {
    id: textBytes,
    ts: new Date(0),
  };
  const [eid, statEID] = makeEID(eidObj);
  if (statEID !== Status.Success) {
    return err(statEID);
  }

  const off = now.getTime() - eidObj.ts.getTime();
  return ok({
    eid,
    off,
    ctr,
    typ: "",
    len: content.length,
    bod: content,
  });
}

export class SingletonStateManager implements IStateManager {
  public latest: SerializedContent | undefined;
  private latestOff = -1;
  private emitter = new TypedEventEmitter<null>();

  constructor(private singletonType: string) {}

  async apply(messages: IMessage[]): Promise<Status[]> {
    for (const msg of messages) {
      const dec = new Decoder(msg.eid);
      const [eidDec, stat] = dec.readStruct(eidCodec);
      if (stat !== Status.Success) continue;

      const encType = new Encoder();
      encType.writeVarString(this.singletonType);
      const typeBytes = encType.result();

      if (
        eidDec.id.length === typeBytes.length &&
        eidDec.id.every((b, i) => b === typeBytes[i])
      ) {
        if (this.latest === undefined || msg.off > this.latestOff) {
          this.latestOff = msg.off;
          this.latest = msg.bod;
          this.emitter.emit(this.singletonType, null);
        }
      }
    }
    return messages.map(() => Status.Success);
  }

  clear = async (): Promise<Status> => {
    this.latest = undefined;
    this.latestOff = -1;
    this.emitter.emit(this.singletonType, null);
    return Status.Success;
  };

  notify = (types: Iterable<string>) => {
    for (const type of types) {
      if (type === this.singletonType) {
        this.emitter.emit(this.singletonType, null);
      }
    }
  };

  refresh = async (_eids: Iterable<EntityID>) => {
    // No durable cache; nothing to pull. Broad notify for this singleton type.
    this.notify([this.singletonType]);
  };

  on = (event: string, listener: () => void) => {
    this.emitter.addEventListener(event, listener);
  };

  off = (event: string, listener: () => void) => {
    this.emitter.removeEventListener(event, listener);
  };
}
