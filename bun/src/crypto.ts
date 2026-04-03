import sodium from "libsodium-wrappers";
import { LibsodiumCrypto } from "../../shared/crypto/libsodium.ts";

await sodium.ready;
const libsodiumCrypto = new LibsodiumCrypto(sodium);
export default libsodiumCrypto;
