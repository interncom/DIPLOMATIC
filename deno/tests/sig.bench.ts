// Ed25519 verify: one imported key reused, vs importKey on every check.
// Message is 128 bytes, about a sealed bag head.

import { NobleCrypto } from "../../shared/crypto/noble.ts";

const noble = new NobleCrypto();
const msg = new Uint8Array(128);
crypto.getRandomValues(msg);

const generated = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);
if (!("publicKey" in generated)) throw new Error("expected key pair");

const raw = await crypto.subtle.exportKey("raw", generated.publicKey);
if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw pub");
const pub = new Uint8Array(raw);
const sig = new Uint8Array(
  await crypto.subtle.sign({ name: "Ed25519" }, generated.privateKey, msg),
);
const verifyKey = await noble.importVerifyKey(pub);

const group = "ed25519 verify";

Deno.bench("checkSig reused key", { group, baseline: true }, async () => {
  const ok = await noble.checkSigEd25519(sig, msg, verifyKey);
  if (!ok) throw new Error("sig");
});

Deno.bench("importVerifyKey", { group }, async () => {
  await noble.importVerifyKey(pub);
});

Deno.bench("import + checkSig", { group }, async () => {
  const key = await noble.importVerifyKey(pub);
  const ok = await noble.checkSigEd25519(sig, msg, key);
  if (!ok) throw new Error("sig");
});
