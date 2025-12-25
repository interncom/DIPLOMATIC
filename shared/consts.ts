export const sigBytes = 64;
export const hashBytes = 32;
export const idxBytes = 8;
export const lenBytes = 8;
export const pubKeyBytes = 32;
export const dkmBytes = 8;

export const tsAuthSize = pubKeyBytes + sigBytes + lenBytes;
export const envelopeHeaderSize = sigBytes + dkmBytes + lenBytes + lenBytes;
export const hashSize = 32;
export const responseItemSize = 33; // status (1) + hash (32)
export const clockToleranceMs = 30000;
