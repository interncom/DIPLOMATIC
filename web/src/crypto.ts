// @ts-expect-error no type declaration
import * as sodium from "../../deno/vendor/raw.githubusercontent.com/interncom/libsodium.js/esm/dist/modules/libsodium-esm-wrappers.js";
import { LibsodiumCrypto } from "./shared/crypto/libsodium";

const libsodiumCrypto = new LibsodiumCrypto(sodium);
export default libsodiumCrypto;
