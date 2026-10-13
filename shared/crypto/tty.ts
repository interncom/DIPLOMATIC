// Paper backup of the master seed to /dev/tty.
// Only Enclave.dumpToTty calls this, and only after the DIP_CLI_DUMP check,
// so a false define drops this module from the web bundle. Does not wipe `seed`.

import { Status } from "../consts.ts";
import { type ValStat } from "../valstat.ts";

// Writes numbered seed hex lines plus a fingerprint check line to /dev/tty.
// Paced mode erases the previous line before the next (Enter between).
export async function dumpToTty(
  seed: Uint8Array,
  fingerprint: () => Promise<ValStat<Uint8Array>>,
): Promise<Status> {
  const ttyPath = "/dev/tty";
  // Non-literal: deno must not load npm:@types/node for this file.
  const fsSpec = "node:fs";
  const asciiSpc = 32;
  const asciiHash = 35;
  const asciiZero = 48;
  const asciiLcA = 87; // 'a' - 10
  const asciiLf = 10;
  const asciiCr = 13;
  const asciiEsc = 27;
  const asciiLbrack = 91;
  const asciiRbrack = 93;
  const asciiA = 65;
  const asciiK = 75;
  const nibbleMask = 15;
  const hexLines = 8;
  const bytesPerLine = 4;
  const hexGroup = 2; // bytes (4 hex chars) before the space
  const pfxLen = 3; // `n] `
  const hexBody = 9; // 4 hex + space + 4 hex
  const rowLen = pfxLen + hexBody;
  const chkLen = 13; // `#] ` + 4 hex + space + 4 hex + LF
  const chkBytes = 4;
  const blankAfter = 3; // last line of first half, if not paced
  // CSI: up 1, erase line, CR — drops the hex line after Enter echo.
  const erasePrev = new Uint8Array([
    asciiEsc,
    asciiLbrack,
    asciiZero + 1,
    asciiA,
    asciiEsc,
    asciiLbrack,
    asciiZero + 2,
    asciiK,
    asciiCr,
  ]);
  const hexDigit = (nib: number) => nib < 10 ? asciiZero + nib : asciiLcA + nib;

  let fsMod: unknown;
  try {
    fsMod = await import(fsSpec);
  } catch {
    return Status.NotImplemented;
  }
  if (fsMod === null || typeof fsMod !== "object") {
    return Status.NotImplemented;
  }
  if (
    !("openSync" in fsMod) || !("writeSync" in fsMod) ||
    !("closeSync" in fsMod)
  ) {
    return Status.NotImplemented;
  }
  const openSync = fsMod.openSync;
  const writeSync = fsMod.writeSync;
  const closeSync = fsMod.closeSync;
  const readSync = "readSync" in fsMod ? fsMod.readSync : undefined;
  if (
    typeof openSync !== "function" || typeof writeSync !== "function" ||
    typeof closeSync !== "function"
  ) {
    return Status.NotImplemented;
  }
  let outFd: unknown;
  let inFd: unknown;
  try {
    outFd = openSync.call(fsMod, ttyPath, "w");
  } catch {
    return Status.NotImplemented;
  }
  if (typeof outFd !== "number") return Status.NotImplemented;
  if (typeof readSync === "function") {
    try {
      inFd = openSync.call(fsMod, ttyPath, "r");
    } catch {
      inFd = undefined;
    }
  }
  const paced = typeof inFd === "number";
  const lineBuf = new Uint8Array(rowLen + 1);
  const chkBuf = new Uint8Array(chkLen);
  const inByte = new Uint8Array(1);
  let fprint: Uint8Array | undefined;
  try {
    const [fp, fst] = await fingerprint();
    if (fst !== Status.Success) return fst;
    fprint = fp;
    for (let line = 0; line < hexLines; line++) {
      let pos = 0;
      lineBuf[pos] = asciiZero + line + 1;
      pos++;
      lineBuf[pos] = asciiRbrack;
      pos++;
      lineBuf[pos] = asciiSpc;
      pos++;
      for (let bi = 0; bi < bytesPerLine; bi++) {
        if (bi === hexGroup) {
          lineBuf[pos] = asciiSpc;
          pos++;
        }
        const byt = seed[line * bytesPerLine + bi];
        if (byt === undefined) return Status.InternalError;
        lineBuf[pos] = hexDigit(byt >> 4);
        pos++;
        lineBuf[pos] = hexDigit(byt & nibbleMask);
        pos++;
      }
      if (paced && typeof readSync === "function") {
        writeSync.call(fsMod, outFd, lineBuf.subarray(0, rowLen));
        lineBuf.fill(0);
        for (;;) {
          const nread = readSync.call(fsMod, inFd, inByte);
          if (typeof nread !== "number" || nread <= 0) break;
          const ch = inByte[0];
          if (ch === asciiLf) break;
          if (ch === asciiCr) {
            readSync.call(fsMod, inFd, inByte);
            break;
          }
        }
        writeSync.call(fsMod, outFd, erasePrev);
      } else {
        lineBuf[pos] = asciiLf;
        writeSync.call(fsMod, outFd, lineBuf.subarray(0, pos + 1));
        lineBuf.fill(0);
        if (line === blankAfter) {
          writeSync.call(fsMod, outFd, new Uint8Array([asciiLf]));
        }
      }
    }
    chkBuf[0] = asciiHash;
    chkBuf[1] = asciiRbrack;
    chkBuf[2] = asciiSpc;
    let chkPos = 3;
    for (let bi = 0; bi < chkBytes; bi++) {
      if (bi === hexGroup) {
        chkBuf[chkPos] = asciiSpc;
        chkPos++;
      }
      const byt = fprint[bi];
      if (byt === undefined) return Status.InternalError;
      chkBuf[chkPos] = hexDigit(byt >> 4);
      chkPos++;
      chkBuf[chkPos] = hexDigit(byt & nibbleMask);
      chkPos++;
    }
    chkBuf[chkPos] = asciiLf;
    writeSync.call(fsMod, outFd, chkBuf);
    return Status.Success;
  } catch {
    return Status.InternalError;
  } finally {
    lineBuf.fill(0);
    chkBuf.fill(0);
    inByte.fill(0);
    fprint?.fill(0);
    try {
      closeSync.call(fsMod, outFd);
    } catch {
      // ignore close fail after write
    }
    if (typeof inFd === "number") {
      try {
        closeSync.call(fsMod, inFd);
      } catch {
        // ignore
      }
    }
  }
}
