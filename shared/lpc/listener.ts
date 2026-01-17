import { IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { Status } from "../consts.ts";
import {
  IPushListener,
  IPushNotifier,
  PushReceiver,
} from "../types.ts";
import type { IHostCrypto } from "../types.ts";
import type { IClock } from "../clock.ts";

export class CallbackListener implements IPushListener {
  private _connected = false;
  private _shut?: () => void;
  constructor(private notifier: IPushNotifier, private crypto: IHostCrypto, private clock: IClock) { }

  connected(): boolean {
    return this._connected;
  }

  async connect(authTS: IAuthTimestamp, recv: PushReceiver, onDisconnect: () => void): Promise<Status> {
    const resp = await this.notifier.open(authTS, recv, this.crypto, this.clock);
    this._shut = resp.shut;
    this._connected = resp.status === Status.Success;
    return resp.status;
  }

  disconnect() {
    this._shut?.();
    this._shut = undefined;
    this._connected = false;
  }
}
