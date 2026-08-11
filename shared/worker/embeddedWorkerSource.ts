// Stub so the module always resolves for tsc / vitest.
// pkg/build-web.mjs overwrites this with the real worker.mjs string for the
// library bundle, then restores this stub. Do not put the real source in git.
export const DIPLOMATIC_WORKER_SOURCE = "";
