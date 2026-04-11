import { IClock } from "./clock";
import { Decoder, Encoder } from "./codec";
import { eidCodec, IEntityID, makeEID } from "./codecs/eid";
import { Status } from "./consts";
import { TypedEventEmitter } from "./events";
import {
  IMessage,
  IStateManager,
  IUpsertMessage,
  SerializedContent,
} from "./types";
import { err, ok, ValStat } from "./valstat";

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

  on = (event: string, listener: () => void) => {
    this.emitter.addEventListener(event, listener);
  };

  off = (event: string, listener: () => void) => {
    this.emitter.removeEventListener(event, listener);
  };
}
