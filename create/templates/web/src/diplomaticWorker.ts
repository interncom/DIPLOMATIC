/**
 * App-owned DIPLOMATIC sync Worker instance.
 *
 * Vite resolves `?worker` against the package export so the script is a real
 * asset in the app bundle. Create once at module scope and pass the instance
 * to `useClient` / `openDiplomaticClient`.
 *
 * Other bundlers / plain HTML: see docs on `openDiplomaticClient`.
 */
import DiplomaticWorker from "@interncom/diplomatic/worker?worker";

export const diplomaticSyncWorker = new DiplomaticWorker();
