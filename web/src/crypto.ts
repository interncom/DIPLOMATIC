// @ts-expect-error no type declaration
import * as sodium from "libsodium.js/dist/modules/libsodium-esm-wrappers.js";
import { LibsodiumCrypto } from "./shared/crypto/libsodium";

const libsodiumCrypto = new LibsodiumCrypto(sodium);
export default libsodiumCrypto;
