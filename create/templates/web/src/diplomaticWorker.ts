/**
 * App-owned DIPLOMATIC sync Worker instance.
 *
 * Vite resolves `?worker` against the package export so the script is a real
 * asset in the app bundle. Create once at module scope and pass the instance
 * to `useClient` / `openDiplomaticClient`.
 *
 * Module-scope construction is intentional and safe: the library handshake
 * recovers if the worker's unsolicited `ready` event fires before the client
 * attaches `onmessage` (probe ping + worker-side cmd hold until init).
 *
 * Other bundlers / plain HTML: see docs on `openDiplomaticClient`.
 */
import DiplomaticWorker from "@interncom/diplomatic/worker?worker";

export const diplomaticSyncWorker = new DiplomaticWorker();
