import { IAuthTimestamp } from "../codecs/authTimestamp.ts";
import { initConnID, Status } from "../consts.ts";
import { takeNotif } from "../sockmsg.ts";
import { IPushListener, IPushNotifier, PushReceiver } from "../types.ts";
import type { IHostCrypto } from "../types.ts";
import type { IClock } from "../clock.ts";

export class CallbackListener implements IPushListener {
  private _connected = false;
  private _shut?: () => void;
  #connID = initConnID;

  constructor(
    private notifier: IPushNotifier,
    private crypto: IHostCrypto,
    private clock: IClock,
  ) {}

  // connID is the host-assigned id. initConnID until the assignment frame arrives.
  connID(): number {
    return this.#connID;
  }

  connected(): boolean {
    return this._connected;
  }

  async connect(
    authTS: IAuthTimestamp,
    recv: PushReceiver,
    _onDisconnect: () => void = () => {},
    onConnect: () => void = () => {},
  ): Promise<Status> {
    this.disconnect();
    const resp = await this.notifier.open(
      authTS,
      (data) => {
        takeNotif(data, recv, (id) => {
          this.#connID = id;
        });
      },
      this.crypto,
      this.clock,
    );
    this._shut = resp.shut;
    this._connected = resp.status === Status.Success;
    if (!this._connected) this.#connID = initConnID;
    if (this._connected) onConnect();
    return resp.status;
  }

  disconnect() {
    this._shut?.();
    this._shut = undefined;
    this._connected = false;
    this.#connID = initConnID;
  }
}
