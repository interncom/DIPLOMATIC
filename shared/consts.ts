export const sigBytes = 64;
export const hashBytes = 32;
export const idxBytes = 8;
export const lenBytes = 8;
export const pubKeyBytes = 32;
export const kdmBytes = 8;
export const eidBytes = 16;
export const clkBytes = 8;
export const hshBytes = 32;

export const tsAuthSize = pubKeyBytes + sigBytes + lenBytes;
export const bagHeaderSize = sigBytes + kdmBytes + lenBytes + lenBytes;
export const responseItemSize = 33; // status (1) + hash (32)
export const clockToleranceMs = 30000;

export enum Status {
  Success = 0,
  InvalidSignature = 3,
  ClockOutOfSync = 4,
  UserNotRegistered = 5,
  ServerMisconfigured = 6,
  MissingBody = 7,
  ExtraBodyContent = 8,
  MissingParam = 9,
  InvalidParam = 10,
  InvalidRequest = 11,
  InternalError = 12,
  NotFound = 13,
  InvalidMessage = 14,
  NoChange = 15,
  DatabaseClosed = 16,
  StorageError = 17,
  DatabaseError = 18,
  HashMismatch = 19,
  DecryptionError = 20,
  NotImplemented = 21,
  MissingSeed = 22,
  OutOfBounds = 23,
  HostError = 24,
  CommunicationError = 25,
  VarLimitExceeded = 26,
  InvalidResponse = 27,
}

export enum APICallName {
  User,
  Peek,
  Push,
  Pull,
}

export const notifierTSAuthURLParam = "t";
