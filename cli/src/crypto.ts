import * as sodium from "https://raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";
import { LibsodiumCrypto } from "../../shared/crypto/libsodium.ts";

const libsodiumCrypto = new LibsodiumCrypto(sodium);
export default libsodiumCrypto;
