// Process-local websocket notifier. Each listener is a callback that writes a socket.

import { CallbackNotifier } from "../../shared/lpc/pusher.ts";

const denoWebsocketNotifier = new CallbackNotifier();
export default denoWebsocketNotifier;
