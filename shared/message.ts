import type { ICrypto, KeyPair } from "./types.ts";
import { Decoder, Encoder } from "./codec.ts";
import { concat } from "./lib.ts";

// Message is also known as the "operation".
// This is the serialized content, plus header data, which determines ordered application.

type EID = Uint8Array;
type SerializedContent = Uint8Array;

// IMessage is an operation.
export interface IMessage {
  eid: Uint8Array;
  clk: Date;
  ctr: number;
  len: number;
  bod?: SerializedContent;
  hsh?: Uint8Array;
}

interface IUpsertMessage extends IMessage {
  bod: SerializedContent;
}

interface IDeleteMessage extends Omit<IMessage, "bod"> {
  len: 0;
}

export type EncodedMessage = Uint8Array;
export type EncryptedMessage = Uint8Array;

export async function genInsert(
  clk: Date,
  content: SerializedContent,
  crypto: ICrypto,
): Promise<IUpsertMessage> {
  const eid = await crypto.gen128BitRandomID();
  return genUpsert(eid, clk, 0, content);
}

export function genUpsert(
  eid: EID,
  clk: Date,
  ctr: number,
  content: SerializedContent,
): IUpsertMessage {
  return {
    eid,
    clk,
    ctr,
    len: content.length,
    bod: content,
  };
}

export function genDelete(eid: EID, clk: Date, ctr: number): IDeleteMessage {
  return {
    eid,
    clk,
    ctr,
    len: 0,
  };
}

// The kdm should be random. Wait.
// That allows attacker to reuse a compromised key.
// It needs to be based on data an attacker cannot know.
// It can't be the hash of meaningful data within the ciphertext.
// That would leak private information.
// Therefore, it must be derived from meaningless data.
// In other words, a random nonce.
// The benefit of the key-per-message is that with a proper HSM,
// the seed never needs to be directly accessible in memory.
// You just feed the KDM into the HSM and get the derived key out.
// Then symmetrically encrypt/decrypt using that derived key.
export const kdmBytes = 8;
export const eidBytes = 16;
export const clkBytes = 8;
export const hshBytes = 32;

// Returns the full encoded message and also a slice of just the encoded header.
export async function encodeOp(
  op: IMessage,
  crypto: ICrypto,
): Promise<[EncodedMessage, Uint8Array]> {
  const headerEncoder = new Encoder();
  headerEncoder.writeBytes(op.eid);
  headerEncoder.writeBigInt(BigInt(op.clk.getTime()));
  headerEncoder.writeVarInt(op.ctr);
  headerEncoder.writeVarInt(op.len);
  if (op.bod && op.len > 0) {
    const hsh = await crypto.blake3(op.bod);
    headerEncoder.writeBytes(hsh);
  }
  const header = headerEncoder.result();
  const body = op.bod || new Uint8Array(0);
  const encoded = concat(header, body);
  return [encoded, header];
}

export async function decodeOp(encoded: EncodedMessage): Promise<IMessage> {
  const decoder = new Decoder(encoded);
  const eid = decoder.readBytes(eidBytes);
  const clkTime = decoder.readBigInt();
  const clk = new Date(Number(clkTime));
  const ctr = decoder.readVarInt();
  const len = decoder.readVarInt();
  let hsh: Uint8Array | undefined;
  let bod: Uint8Array | undefined;
  if (len > 0) {
    hsh = decoder.readBytes(hshBytes);
    bod = decoder.readBytes(len);
  }
  return { eid, clk, ctr, len, bod, hsh };
}

export async function derivationKeyMaterial(
  crypto: ICrypto,
): Promise<Uint8Array> {
  const random = await crypto.gen128BitRandomID();
  return random.slice(0, kdmBytes);
}
