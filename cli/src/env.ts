// Loads a master seed and a host URL from the environment.

import { htob } from "../shared/binary.ts";
import { Status } from "../shared/consts.ts";
import { Enclave } from "../shared/crypto/enclave.ts";
import type { IHostConnectionInfo } from "../shared/types.ts";

// loadEnclaveOrPanic reads a 32-byte master seed hex from envVar.
export function loadEnclaveOrPanic(envVar: string): Enclave {
  const seedHex = process.env[envVar];
  if (!seedHex) {
    console.error(`${envVar} env var missing`);
    process.exit(1);
  }
  const bytes = htob(seedHex);
  const [enclave, st] = Enclave.fromBytes(bytes);
  bytes.fill(0);
  if (st !== Status.Success || enclave === undefined) {
    console.error(`${envVar} must be 64 hex chars (32-byte master seed)`);
    process.exit(1);
  }
  return enclave;
}

// loadHostOrPanic reads a host URL from envVar. The label is "host".
export function loadHostOrPanic(envVar: string): IHostConnectionInfo<URL> {
  const hostURL = process.env[envVar];
  if (!hostURL) {
    console.error(`${envVar} env var missing`);
    process.exit(1);
  }
  return {
    handle: new URL(hostURL),
    label: "host",
  };
}
