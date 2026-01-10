import { IAuthTimestamp } from "../codecs/authTimestamp.ts";
import {
  IPushListener,
  IPushNotifier,
  PushReceiver,
} from "../types.ts";

export class CallbackListener implements IPushListener {
  private _connected = false;
  private _shut?: () => void;
  constructor(private notifier: IPushNotifier) { }

  connected(): boolean {
    return this._connected;
  }

  connect(authTS: IAuthTimestamp, recv: PushReceiver) {
    const { notifier } = this;
    const { shut } = notifier.open(authTS, recv);
    this._shut = shut;
    this._connected = true;
  }

  disconnect() {
    this._shut?.();
    this._shut = undefined;
    this._connected = false;
  }
}
